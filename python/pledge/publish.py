"""The command line as a client of the Pledge API: register a run, report progress while it works, and send
its result so the dashboard can show it.

What is sent is a summary built from the run directories: per-pledge counts, each seed's expected and actual
values, the fault plan and the timings. The evidence files themselves stay where they are.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from pledge.recording import recording
from pledge.verdict import app_down

DEFAULT_API = "https://app.pledge.sh"
TOKEN_FILE = Path.home() / ".config/workz/pledge.env"
DOWN_NOTE = "The app did not answer one request successfully on this seed (it was down), so its checks are counted as unknown."
MAX_VALUE_CHARS = 2000  # of one expected or actual value, as JSON


def _bounded(value: object) -> object:
    text = json.dumps(value)
    return value if len(text) <= MAX_VALUE_CHARS else text[: MAX_VALUE_CHARS - 20] + "... [cut]"


def _seed(result: dict, assertion: str) -> dict:
    row = next((row for row in result["assertions"] if row["id"] == assertion), None)
    entry: dict = {"seed": result["seed"], "run_id": result["run_id"], "status": row["status"] if row else "unknown"}
    if row is None:
        return entry
    # An observation carries expected/actual itself; a per-journey check carries them on its failing samples.
    sample = row if "expected" in row or "actual" in row else (row.get("failures") or [{}])[0]
    for key in ("expected", "actual"):
        if sample.get(key) is not None:
            entry[key] = _bounded(sample[key])
    if row.get("failed"):
        entry["failed"] = row["failed"]
    return entry


def _authoring(app_dir: Path) -> dict | None:
    path = app_dir / ".pledge-runs" / "author-report.json"
    if not path.is_file():
        return None
    report = json.loads(path.read_text())
    final = report["phases"][-1]["result"]
    return {
        "seconds": report["seconds"],
        "phases": [
            {"phase": phase["phase"], "model": phase["model"], **{key: phase["usage"][key] for key in ("requests", "tokens", "cache_read_tokens", "output_tokens", "commands", "seconds", "rejected_finishes")}}
            for phase in report["phases"]
        ],
        "summary": str(final.get("summary", ""))[:6000],
        "open_questions": [str(question)[:1000] for question in final.get("open_questions", [])][:20],
    }


def seed_counts(run_dir: Path) -> dict:
    """How one seed went, for the live view: checks that held and checks that broke."""
    result = json.loads((run_dir / "result.json").read_text())
    statuses = [row["status"] for row in result["assertions"]]
    return {"seed": result["seed"], "kept": statuses.count("pass"), "broken": statuses.count("fail")}


def build_record(app_dir: Path, report: dict, run_dirs: list[Path], faults_file: Path | None, env: dict[str, str]) -> dict:
    """The run's result as the API wants it. `report` is what `pledge.verdict.verdict` returned."""
    pairs = sorted(((run_dir, json.loads((run_dir / "result.json").read_text())) for run_dir in run_dirs), key=lambda pair: pair[1]["seed"])
    run_dirs, results = [pair[0] for pair in pairs], [pair[1] for pair in pairs]
    down = {result["seed"] for run_dir, result in pairs if app_down(run_dir)}
    runs = []
    for run_dir, result in zip(run_dirs, results):
        injected = run_dir / "pledge" / "proxy_injected.json"
        metrics = result.get("metrics", {})
        # Failures the scenario did not declare as expected. A reply replaced by an injected fault is declared.
        unexpected = metrics.get("unexpected_http_failure_rate") or metrics.get("http_req_failed_rate") or {}
        runs.append({
            "seed": result["seed"], "run_id": result["run_id"], "verdict": result["verdict"],
            "faults_injected": len(json.loads(injected.read_text())) if injected.is_file() else 0,
            "journeys": int(metrics.get("iterations") or 0),
            "requests": int(metrics.get("http_reqs") or 0), "unexpected_failures": int(unexpected.get("failed") or 0),
            "limitations": ([DOWN_NOTE] if result["seed"] in down else []) + [str(item)[:500] for item in result.get("limitations", [])][:19],
        })
    pledges = [
        {
            "id": row["id"], "statement": row["statement"][:1000], "status": row["status"], "source": row["source"],
            "confidence": row["confidence"], "assertion": row["assertion"], "result": row["result"],
            "kept": row["kept"], "broken": row["broken"], "unknown": row["unknown"],
            "seeds": [_seed(result, row["assertion"]) if result["seed"] not in down else {"seed": result["seed"], "run_id": result["run_id"], "status": "unknown"} for result in results],
        }
        for row in report["pledges"] if "kept" in row
    ]
    for pledge in pledges:
        if pledge["broken"]:
            found = (recording(run_dir, pledge["assertion"], pledge["statement"]) for run_dir, result in pairs if result["seed"] not in down)
            pledge["recording"] = next((item for item in found if item), None)
    faults = None
    if faults_file is not None:
        document = json.loads(faults_file.read_text())
        faults = {"name": faults_file.stem, "description": str(document.get("description", ""))[:1000], "faults": [{"kind": f["kind"], "target": f["target"], "params": f.get("params", {})} for f in document["faults"]]}
    sandbox = report.get("sandbox")
    return {
        "schema_version": 1, "scenario": report["scenario"], "faults": faults, "env": env, "pledges": pledges,
        "runs": sorted(runs, key=lambda run: run["seed"]),
        "sandbox": sandbox and {key: sandbox[key] for key in ("template", "outbound_blocked", "seconds")},
        "authoring": _authoring(app_dir),
    }


def _token() -> str:
    if os.environ.get("PLEDGE_API_TOKEN"):
        return os.environ["PLEDGE_API_TOKEN"]
    try:
        for line in TOKEN_FILE.read_text().splitlines():
            name, _, value = line.partition("=")
            if name == "PLEDGE_API_TOKEN" and value.strip():
                return value.strip()
    except OSError:
        pass
    raise RuntimeError(f"PLEDGE_API_TOKEN is not set and {TOKEN_FILE} does not have it")


class LiveRun:
    """One run on the API, from the moment the command line starts it."""

    def __init__(self, repo: str, trigger: str = "manual", phase: str = "run", scenario: str | None = None, seeds: int | None = None) -> None:
        self.api = os.environ.get("PLEDGE_API_URL", DEFAULT_API).rstrip("/")
        self._token = _token()
        run = self._call("POST", f"/api/repos/{urllib.request.quote(repo, safe='')}/runs", {"trigger": trigger, "phase": phase, "scenario": scenario, "seeds": seeds})
        self.id, self.repo_id = run["id"], run["repoId"]
        self.url = f"{self.api}/r/{self.repo_id}/runs/{self.id}"

    def _call(self, method: str, path: str, body: dict | bytes) -> dict:
        raw = isinstance(body, bytes)
        request = urllib.request.Request(
            self.api + path, data=body if raw else json.dumps(body).encode(), method=method,
            headers={"content-type": "application/octet-stream" if raw else "application/json", "authorization": f"Bearer {self._token}"},
        )
        try:
            with urllib.request.urlopen(request, timeout=120 if raw else 30) as response:
                return json.load(response)["data"]
        except urllib.error.HTTPError as error:
            try:
                detail = json.load(error).get("error")
            except ValueError:
                detail = error.reason
            raise RuntimeError(f"the API refused {path} (HTTP {error.code}): {detail}") from None
        except urllib.error.URLError as error:
            raise RuntimeError(f"could not reach {self.api}: {error.reason}") from None

    def event(self, event_type: str, **payload: object) -> None:
        """Progress for the live view. Best effort: a scan never fails because the dashboard missed a step."""
        try:
            self._call("POST", f"/api/runs/{self.id}/events", {"type": event_type, "payload": payload})
        except RuntimeError as exc:
            print(f"pledge: progress not sent: {exc}", file=sys.stderr)

    def phase(self, name: str) -> None:
        self.event("phase_started", phase=name)

    def failed(self, reason: str) -> None:
        self.event("run_finished", failed=reason[:500])

    def finish(self, record: dict) -> dict:
        return self._call("POST", f"/api/runs/{self.id}/result", record)

    def media(self, run_dirs: list[Path]) -> list[str]:
        """Send the browser recording of the first seed that has one. Best effort, like progress."""
        for run_dir in sorted(run_dirs, key=lambda path: json.loads((path / "result.json").read_text())["seed"]):
            info_file = run_dir / "pledge" / "browser" / "browser.json"
            if not info_file.is_file():
                continue
            info, seed = json.loads(info_file.read_text()), json.loads((run_dir / "result.json").read_text())["seed"]
            if "trace.zip" not in info["files"]:
                continue
            query = urllib.parse.urlencode({"seed": seed, "journey": info["journey"]})
            try:
                for name in info["files"]:
                    self._call("PUT", f"/api/runs/{self.id}/media/{name}?{query}", (info_file.parent / name).read_bytes())
            except RuntimeError as exc:
                print(f"pledge: browser recording not sent: {exc}", file=sys.stderr)
                return []
            return info["files"]
        return []
