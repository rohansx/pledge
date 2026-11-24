"""What the control plane knows and decides, over documents in a Store.

Writes: a run is registered, emits events while it works, and finishes with per-pledge results; finishing
updates the pledge catalogue and opens, reopens or verifies findings. Reads: the views each dashboard tab
needs, derived here so the browser gets one call per tab.

Two rules live here and nowhere else:
  * only an approved pledge can make a run's verdict "broken";
  * a finding becomes "verified" only when a later run keeps its pledge on every seed.
"""

from __future__ import annotations

import re
import uuid
from datetime import datetime

from pledge.api.models import EventIn, FindingPatch, PledgePatch, RunResultIn, RunStartIn
from pledge.api.store import Store, now

SEP = "~"
SOURCES = {"stated": "code", "domain_template": "template", "inferred": "inferred"}
HISTORY_RUNS = 20
LATEST = 5
TREND_WEEKS = 12


class NotFound(LookupError):
    pass


class Refused(ValueError):
    """The request is understood but breaks a rule; the message says which."""


def slug(name: str) -> str:
    value = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:60]
    if not value:
        raise Refused("a repo name needs at least one letter or digit")
    return value


def _need(store: Store, kind: str, doc_id: str) -> dict:
    doc = store.get(kind, doc_id)
    if doc is None:
        raise NotFound(f"no {kind} {doc_id}")
    return doc


# ---------------------------------------------------------------- writes


def start_run(store: Store, repo_name: str, start: RunStartIn) -> dict:
    repo_id = slug(repo_name)
    if store.get("repo", repo_id) is None:
        # ponytail: a repo exists once something is published under its name. The GitHub App will create
        # repos from an installation instead, and this becomes a lookup.
        store.put("repo", {"id": repo_id, "name": repo_name, "created_at": now()})
    run = {
        "id": str(uuid.uuid4()), "repo_id": repo_id, "created_at": now(), "finished_at": None,
        "trigger": start.trigger, "commit": start.commit, "pull_request": start.pull_request,
        "phase": start.phase, "scenario": start.scenario, "seeds_planned": start.seeds,
        "faults_name": None, "record": None, "results": [], "failure": None,
    }
    store.put("run", run)
    store.add_event(run["id"], "phase_started", {"phase": start.phase})
    return run


def record_event(store: Store, run_id: str, event: EventIn) -> int:
    run = _need(store, "run", run_id)
    if run["phase"] in ("done", "failed"):
        raise Refused("this run has already finished")
    if event.type == "run_finished":
        # Sent by the runner only when it gives up; a successful run finishes through finish_run.
        run.update(phase="failed", finished_at=now(), failure=str(event.payload.get("failed", "the run stopped"))[:500])
        store.put("run", run)
    elif event.type == "phase_started" and event.payload.get("phase") in ("boot", "author", "prove", "run"):
        run["phase"] = event.payload["phase"]
        store.put("run", run)
    return store.add_event(run_id, event.type, event.payload)


def _pledge_id(repo_id: str, scenario: str, key: str) -> str:
    return SEP.join((repo_id, scenario, key))


def finish_run(store: Store, run_id: str, result: RunResultIn) -> dict:
    run = _need(store, "run", run_id)
    if run["phase"] in ("done", "failed"):
        raise Refused("this run has already finished")
    repo_id, stamp = run["repo_id"], now()
    faults_name = result.faults.name if result.faults else None

    results, finding_ids = [], []
    for item in result.pledges:
        pledge_id = _pledge_id(repo_id, result.scenario, item.id)
        pledge = store.get("pledge", pledge_id) or {
            "id": pledge_id, "repo_id": repo_id, "created_at": stamp, "key": item.id, "scenario": result.scenario,
            # A pledge starts with the status its file carries. After that, status changes only by a decision here.
            "status": item.status, "decision": None, "planted_bugs_caught": 0,
        }
        pledge.update(statement=item.statement, source=SOURCES.get(item.source, "inferred"), confidence=item.confidence, assertion=item.assertion, updated_at=stamp)
        store.put("pledge", pledge)
        results.append({"pledge_id": pledge_id, "result": item.result, "kept": item.kept, "broken": item.broken, "unknown": item.unknown, "seeds": [seed.model_dump(exclude_none=True) for seed in item.seeds]})
        finding = _update_finding(store, run, pledge, item, faults_name, stamp)
        if finding and item.result == "broken":
            finding_ids.append(finding["id"])

    run.update(phase="done", finished_at=stamp, scenario=result.scenario, faults_name=faults_name, record=result.model_dump(exclude={"pledges"}), results=results)
    store.put("run", run)
    view = run_view(store, run)
    store.add_event(run_id, "run_finished", {"verdict": view["verdict"], "summary": view["summary"], "finding_ids": finding_ids})
    return view


def _update_finding(store: Store, run: dict, pledge: dict, item, faults_name: str | None, stamp: str) -> dict | None:
    """Open, reopen or verify the finding for one pledge after a run. One finding per pledge at a time."""
    existing = next((finding for finding in store.list("finding", run["repo_id"]) if finding["pledge_id"] == pledge["id"]), None)
    broken_seeds = [seed.seed for seed in item.seeds if seed.status == "fail"]

    if item.result == "broken":
        if existing is None:
            finding = {"id": str(uuid.uuid4()), "repo_id": run["repo_id"], "created_at": stamp, "pledge_id": pledge["id"], "status": "open", "first_run_id": run["id"], "history": [{"at": stamp, "status": "open", "run_id": run["id"]}]}
        else:
            finding = existing
            # Broke again after someone said it was fixed, or after a rerun had verified the fix.
            if finding["status"] in ("fixed_unverified", "verified"):
                finding["status"] = "reopened"
                finding["history"].append({"at": stamp, "status": "reopened", "run_id": run["id"]})
        finding.update(statement=pledge["statement"], run_id=run["id"], faults_name=faults_name, broken_seeds=broken_seeds, total_seeds=len(item.seeds), updated_at=stamp)
        store.put("finding", finding)
        return finding

    # Verified only by evidence: a later run, under the fault plan that broke it, keeps the pledge on every seed.
    if existing and existing["status"] != "verified" and item.result == "kept" and existing.get("faults_name") == faults_name:
        existing["status"] = "verified"
        existing["verified_run_id"] = run["id"]
        existing["updated_at"] = stamp
        existing["history"].append({"at": stamp, "status": "verified", "run_id": run["id"]})
        store.put("finding", existing)
    return existing


def patch_finding(store: Store, finding_id: str, patch: FindingPatch) -> dict:
    finding = _need(store, "finding", finding_id)
    if finding["status"] == "verified":
        raise Refused("a verified finding changes only when a later run breaks the pledge again")
    if finding["status"] != patch.status:
        finding["status"] = patch.status
        finding["updated_at"] = now()
        finding["history"].append({"at": finding["updated_at"], "status": patch.status, "run_id": None})
        store.put("finding", finding)
    return finding_view(store, finding)


def patch_pledge(store: Store, pledge_id: str, patch: PledgePatch) -> dict:
    pledge = _need(store, "pledge", pledge_id)
    if patch.action == "approve":
        if pledge["status"] == "retired":
            raise Refused("a retired pledge cannot be approved; propose it again from the repo")
        if pledge["status"] != "proven" and not patch.override:
            raise Refused("this pledge has not been proven by a planted bug; approving it needs an explicit override")
        status = "approved"
    else:
        status = "retired"
    stamp = now()
    pledge.update(status=status, updated_at=stamp, decision={"action": patch.action, "override": patch.override and patch.action == "approve", "note": patch.note, "at": stamp})
    store.put("pledge", pledge)
    return pledge_view(store, pledge)


# ---------------------------------------------------------------- reads


def _summary(run: dict) -> dict | None:
    """The run strip. "Succeeded" excludes only responses the scenario did not expect; a reply replaced by an
    injected fault is the fault working, not the app failing."""
    record = run.get("record")
    if not record:
        return None
    seeds = record["runs"]
    sent = sum(seed.get("requests", 0) for seed in seeds)
    return {
        "requestsSent": sent,
        "requestsSucceeded": sent - sum(seed.get("unexpected_failures", 0) for seed in seeds),
        "pledgesChecked": len(run["results"]),
        "pledgesBroken": sum(1 for result in run["results"] if result["result"] == "broken"),
        "seeds": len(seeds),
        "faultsInjected": sum(seed["faults_injected"] for seed in seeds),
    }


def _verdict(run: dict, pledges: dict[str, dict]) -> str | None:
    if run["phase"] != "done":
        return None
    approved = [result for result in run["results"] if pledges.get(result["pledge_id"], {}).get("status") == "approved"]
    if any(result["result"] == "broken" for result in approved):
        return "broken"
    return "kept" if approved and all(result["result"] == "kept" for result in approved) else "inconclusive"


def _duration(run: dict) -> float | None:
    record = run.get("record") or {}
    total = (record.get("sandbox") or {}).get("seconds", {}).get("total")
    authoring = (record.get("authoring") or {}).get("seconds")
    if total is None and authoring is None:
        return None
    return round((total or 0) + (authoring or 0), 1)


def _pledges(store: Store, repo_id: str) -> dict[str, dict]:
    return {pledge["id"]: pledge for pledge in store.list("pledge", repo_id)}


def run_row(run: dict, pledges: dict[str, dict]) -> dict:
    return {
        "id": run["id"], "repoId": run["repo_id"], "createdAt": run["created_at"], "finishedAt": run["finished_at"],
        "trigger": run["trigger"], "commit": run["commit"], "pullRequest": run["pull_request"], "phase": run["phase"],
        "scenario": run["scenario"], "faults": run["faults_name"], "verdict": _verdict(run, pledges), "summary": _summary(run),
        "durationSeconds": _duration(run), "costUsd": None, "seedsPlanned": run.get("seeds_planned"), "failure": run.get("failure"),
        "seedVerdicts": [seed["verdict"] for seed in (run.get("record") or {}).get("runs", [])],
        "authored": bool((run.get("record") or {}).get("authoring")),
    }


def run_view(store: Store, run: dict) -> dict:
    pledges = _pledges(store, run["repo_id"])
    record = run.get("record") or {}
    results = [
        {**result, "pledgeId": result["pledge_id"], "statement": pledges[result["pledge_id"]]["statement"], "status": pledges[result["pledge_id"]]["status"]}
        for result in run["results"] if result["pledge_id"] in pledges
    ]
    findings = [finding["id"] for finding in store.list("finding", run["repo_id"]) if finding.get("run_id") == run["id"]]
    return {
        **run_row(run, pledges),
        "results": sorted(results, key=lambda result: result["result"] != "broken"),
        "faultPlan": record.get("faults"), "seedRuns": record.get("runs", []), "sandbox": record.get("sandbox"),
        "authoring": record.get("authoring"), "env": record.get("env", {}), "findingIds": findings,
    }


def _standing(store: Store, repo_id: str) -> dict[str, dict]:
    """Each pledge's latest result. A run under faults says more than a baseline, so it wins over a newer baseline."""
    best: dict[str, dict] = {}
    for run in store.list("run", repo_id):  # newest first
        if run["phase"] != "done":
            continue
        for result in run["results"]:
            current = best.get(result["pledge_id"])
            if current is None or (current["faults"] is None and run["faults_name"] is not None):
                best[result["pledge_id"]] = {**result, "run_id": run["id"], "faults": run["faults_name"], "at": run["created_at"]}
    return best


def _history(store: Store, pledge_id: str, repo_id: str) -> list[dict]:
    points = []
    for run in store.list("run", repo_id):
        for result in run["results"]:
            if result["pledge_id"] == pledge_id:
                points.append({"runId": run["id"], "at": run["created_at"], "faults": run["faults_name"], "result": result["result"]})
    return points[:HISTORY_RUNS]


def pledge_row(pledge: dict, standing: dict[str, dict]) -> dict:
    last = standing.get(pledge["id"])
    return {
        "id": pledge["id"], "repoId": pledge["repo_id"], "key": pledge["key"], "scenario": pledge["scenario"], "statement": pledge["statement"],
        "status": pledge["status"], "source": pledge["source"], "sourceRef": None, "confidence": pledge["confidence"],
        "plantedBugsCaught": pledge["planted_bugs_caught"], "lastVerdict": last["result"] if last else None,
        "lastRunId": last["run_id"] if last else None, "lastFaults": last["faults"] if last else None,
        "lastSeeds": [seed["status"] for seed in last["seeds"]] if last else [], "decision": pledge.get("decision"),
    }


def pledge_list(store: Store, repo_id: str, status: str | None = None) -> list[dict]:
    _need(store, "repo", repo_id)
    standing = _standing(store, repo_id)
    order = {"broken": 0, "inconclusive": 1, "kept": 2, None: 3}
    rows = [pledge_row(pledge, standing) for pledge in store.list("pledge", repo_id) if status is None or pledge["status"] == status]
    return sorted(rows, key=lambda row: (order[row["lastVerdict"]], row["scenario"], row["key"]))


def pledge_view(store: Store, pledge: dict) -> dict:
    standing = _standing(store, pledge["repo_id"])
    last = standing.get(pledge["id"])
    finding = next((f for f in store.list("finding", pledge["repo_id"]) if f["pledge_id"] == pledge["id"]), None)
    return {
        **pledge_row(pledge, standing), "assertion": pledge["assertion"], "file": f".pledge/pledges/{pledge['key']}.json",
        "seeds": last["seeds"] if last else [], "history": _history(store, pledge["id"], pledge["repo_id"]),
        "findingId": finding["id"] if finding else None, "plantedBugs": [],
    }


def _replay(scenario: str, faults_name: str | None, seed: int) -> str:
    faults = f" --faults .pledge/faults/{faults_name}.json" if faults_name else ""
    return f"pledge run . --scenario {scenario}{faults} --seed {seed}"


def finding_row(finding: dict, pledges: dict[str, dict]) -> dict:
    pledge = pledges.get(finding["pledge_id"], {})
    return {
        "id": finding["id"], "repoId": finding["repo_id"], "pledgeId": finding["pledge_id"], "pledgeKey": pledge.get("key"),
        "pledgeStatus": pledge.get("status"), "statement": finding["statement"], "status": finding["status"], "runId": finding["run_id"],
        "brokenSeeds": finding["broken_seeds"], "totalSeeds": finding["total_seeds"], "faults": finding.get("faults_name"),
        "firstSeen": finding["created_at"], "updatedAt": finding["updated_at"],
    }


def finding_list(store: Store, repo_id: str, status: str | None = None) -> list[dict]:
    _need(store, "repo", repo_id)
    pledges = _pledges(store, repo_id)
    return [finding_row(finding, pledges) for finding in store.list("finding", repo_id) if status is None or finding["status"] == status]


def finding_view(store: Store, finding: dict) -> dict:
    pledges = _pledges(store, finding["repo_id"])
    run = store.get("run", finding["run_id"]) or {"results": [], "record": None, "scenario": None, "phase": "done"}
    result = next((item for item in run["results"] if item["pledge_id"] == finding["pledge_id"]), {"seeds": []})
    first_broken = next((seed for seed in result["seeds"] if seed["status"] == "fail"), {})
    record = run.get("record") or {}
    return {
        **finding_row(finding, pledges),
        "seeds": result["seeds"], "expected": first_broken.get("expected"), "actual": first_broken.get("actual"),
        "summary": _summary(run) if run.get("record") else None, "faultPlan": record.get("faults"),
        # Neither exists yet: the proxy records which faults it injected, not an ordered story per journey,
        # and nothing shrinks a fault plan. Empty rather than invented.
        "timeline": [], "minimalFaultPlan": [],
        "replayCommand": _replay(run.get("scenario") or "", finding.get("faults_name"), (finding["broken_seeds"] or [1])[0]),
        "history": finding["history"], "blocks": pledges.get(finding["pledge_id"], {}).get("status") == "approved",
    }


def repo_list(store: Store) -> list[dict]:
    rows = []
    for repo in store.list("repo"):
        pledges = _pledges(store, repo["id"])
        runs = store.list("run", repo["id"])
        latest = next((run for run in runs if run["phase"] == "done"), None)
        rows.append({
            "id": repo["id"], "name": repo["name"], "createdAt": repo["created_at"], "pledges": len(pledges),
            "openFindings": sum(1 for finding in store.list("finding", repo["id"]) if finding["status"] != "verified"),
            "latestRun": run_row(latest, pledges) if latest else None, "lastActivity": runs[0]["created_at"] if runs else repo["created_at"],
        })
    return sorted(rows, key=lambda row: row["lastActivity"], reverse=True)


def overview(store: Store, repo_id: str) -> dict:
    repo = _need(store, "repo", repo_id)
    pledges = _pledges(store, repo_id)
    runs = store.list("run", repo_id)
    findings = store.list("finding", repo_id)
    standing = _standing(store, repo_id)
    active = {pid: pledge for pid, pledge in pledges.items() if pledge["status"] != "retired" and pid in standing}
    broken = [pledge_row(pledge, standing) for pid, pledge in active.items() if standing[pid]["result"] == "broken"]
    done = [run for run in runs if run["phase"] == "done"]

    weeks: dict[str, dict] = {}
    for run in done:
        year, week, _ = datetime.fromisoformat(run["created_at"]).isocalendar()
        bucket = weeks.setdefault(f"{year}-W{week:02d}", {"kept": 0, "broken": 0})
        for result in run["results"]:
            if result["result"] in bucket:
                bucket[result["result"]] += 1

    return {
        "repo": {"id": repo["id"], "name": repo["name"]},
        "headline": {
            "kept": sum(1 for pid in active if standing[pid]["result"] == "kept"), "total": len(active), "broken": broken,
            "blocking": sum(1 for row in broken if row["status"] == "approved"),
            "approved": sum(1 for pledge in active.values() if pledge["status"] == "approved"),
        },
        "latestRun": run_row(done[0], pledges) if done else None,
        "runningRunId": next((run["id"] for run in runs if run["phase"] not in ("done", "failed")), None),
        "counters": {
            "bugsCaught": len(findings), "pullRequestsChecked": sum(1 for run in done if run["trigger"] == "pull_request"),
            "faultsInjected": sum((_summary(run) or {}).get("faultsInjected", 0) for run in done),
            "approvedPledges": sum(1 for pledge in pledges.values() if pledge["status"] == "approved"),
            "seedsRun": sum((_summary(run) or {}).get("seeds", 0) for run in done),
            "awaitingReview": sum(1 for pledge in pledges.values() if pledge["status"] in ("proposed", "proven")),
            "openFindings": sum(1 for finding in findings if finding["status"] != "verified"),
        },
        "trend": [{"week": week, **counts} for week, counts in sorted(weeks.items())][-TREND_WEEKS:],
        "latestRuns": [run_row(run, pledges) for run in runs[:LATEST]],
        "latestFindings": [finding_row(finding, pledges) for finding in findings[:LATEST]],
    }


def pr_comment(store: Store, run: dict, base_url: str) -> str:
    """The pull request comment for a finished run, in the dashboard's own words."""
    view = run_view(store, run)
    summary = view["summary"] or {"requestsSent": 0, "requestsSucceeded": 0, "pledgesBroken": 0}
    blocking = [r for r in view["results"] if r["result"] == "broken" and r["status"] == "approved"]
    review = [r for r in view["results"] if r["result"] == "broken" and r["status"] != "approved"]
    kept = sum(1 for r in view["results"] if r["result"] == "kept")
    findings = {finding["pledge_id"]: finding["id"] for finding in store.list("finding", run["repo_id"])}
    share = 100 if not summary["requestsSent"] else int(100 * summary["requestsSucceeded"] / summary["requestsSent"])

    def line(result: dict) -> str:
        link = f" [View finding]({base_url}/r/{run['repo_id']}/findings/{findings[result['pledgeId']]})" if result["pledgeId"] in findings else ""
        return f"- {result['statement']} Broke on {result['broken']} of {len(result['seeds'])} seeds.{link}"

    lines = [
        f"**Pledge: {len(blocking)} of {len(view['results'])} pledges broken**" if blocking else f"**Pledge: no approved pledge broken** ({len(view['results'])} checked)",
        "",
        f"{summary['requestsSent']:,} requests sent · {share}% returned success · {summary['pledgesBroken']} pledges broken",
    ]
    if blocking:
        lines += ["", "**Broken**", *map(line, blocking)]
    if review:
        lines += ["", "**For review** (not approved, so these do not fail the check)", *map(line, review)]
    lines += ["", f"Kept: {kept}. Skipped (not touched by this change): 0."]
    return "\n".join(lines)
