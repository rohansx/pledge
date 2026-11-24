"""A recording of one journey that broke a pledge: its requests in order, the faults the proxy injected into
them, and the check that failed. Built from a run directory after the run, for the dashboard to play back.

The proxy logs every request with the journey key the scenario sent in `X-Pledge-Journey`. Calls the app made
to its dependencies carry no journey key, so they are not in the recording.
"""

from __future__ import annotations

import json
from pathlib import Path

MAX_STEPS = 80


def _journey(row: dict, traffic: list[dict]) -> str | None:
    """The journey to replay: the one the check named, else (for a whole-run check) the first one a fault hit."""
    for failure in row.get("failures") or []:
        if failure.get("logical_key"):
            return failure["logical_key"]
    return next((entry["journey"] for entry in traffic if entry.get("journey") and entry.get("fault") is not None), None)


def _step(entry: dict, start: int) -> dict:
    where = f"{entry['method']} {entry['path']}"
    detail = {"request": entry.get("request", ""), "reply": entry.get("reply", "")}
    if entry.get("fault") is not None:
        text = f"{where}: the app did the work and answered {entry['upstream_status']}, but the reply was lost. The client got {entry['returned_status']}."
        return {"at": entry["at_ms"] - start, "actor": "fault", "text": text, "detail": detail}
    if entry.get("upstream_status") is None:
        return {"at": entry["at_ms"] - start, "actor": "client", "text": f"{where} → app unreachable ({entry['returned_status']})", "detail": detail}
    return {"at": entry["at_ms"] - start, "actor": "client", "text": f"{where} → {entry['returned_status']}", "detail": detail}


def recording(run_dir: Path, assertion: str, statement: str) -> dict | None:
    """None when the run has no traffic log, the check did not fail, or no request carried a journey key."""
    traffic_file = run_dir / "pledge" / "proxy_traffic.json"
    if not traffic_file.is_file():
        return None
    result = json.loads((run_dir / "result.json").read_text())
    row = next((row for row in result["assertions"] if row["id"] == assertion and row["status"] == "fail"), None)
    if row is None:
        return None
    traffic = json.loads(traffic_file.read_text())
    journey = _journey(row, traffic)
    entries = [entry for entry in traffic if journey and entry.get("journey") == journey]
    if not entries:
        return None
    start = entries[0]["at_ms"]
    steps = [_step(entry, start) for entry in entries[:MAX_STEPS]]
    failure = next((f for f in row.get("failures") or [] if f.get("logical_key") == journey), row)
    found = f"expected {json.dumps(failure.get('expected'))[:200]}, found {json.dumps(failure.get('actual'))[:200]}"
    steps.append({"at": entries[-1]["at_ms"] - start, "actor": "check", "text": f"Broken: {statement[:700]} ({found})", "detail": None})
    return {"seed": result["seed"], "journey": journey, "faults_hit": sum(entry.get("fault") is not None for entry in entries), "steps": steps}
