"""What the control plane knows and decides, over documents in a Store.

Writes: a run is registered, emits events while it works, and finishes with per-pledge results; finishing
updates the pledge catalogue and opens, reopens or verifies findings. Reads: the views each dashboard tab
needs, derived here so the browser gets one call per tab.

Rules that live here and nowhere else:
  * only an approved pledge can make a run's verdict "broken";
  * a pledge's standing is the worst of its latest conclusive result under each fault plan, and the headline,
    the pledge list and the findings are all read off that one computation (`_plans`);
  * a finding becomes "verified" only when a later run, under the fault plan that broke it, keeps its pledge
    on every seed;
  * a check that passed while its fault plan injected nothing, or failed without reading a value, is unknown.

Stored runs keep what was measured. `_read` is the one place that interprets them, at read time, so a rule
that changes here corrects every run already published.
"""

from __future__ import annotations

import re
import uuid
from datetime import UTC, datetime, timedelta

from pledge.api.models import EventIn, FindingPatch, GitHubRepo, InstallationEvent, PledgePatch, PullRequestEvent, RunResultIn, RunStartIn
from pledge.api.store import MAX_CLAIMS, Store, now

SEP = "~"
JOB_STALE_SECONDS = 60 * 60  # a job running this long has lost its worker
SOURCES = {"stated": "code", "domain_template": "template", "inferred": "inferred"}
# Findings a shipped client can cause come first; ones only a direct API caller could cause come last.
REACH_ORDER = {"ui": 0, "client": 0, "provider": 0, "internal": 0, "unknown": 1, "api_only": 2}
HISTORY_RUNS = 20
LATEST = 5
TREND_WEEKS = 12
ABANDONED_AFTER = timedelta(hours=2)
UNFIRED_NOTE = "The fault plan injected no fault on this seed, so a check that passed here proves nothing: counted as unknown."
RANK = {"broken": 0, "kept": 1, "inconclusive": 2}


class NotFound(LookupError):
    pass


class Refused(ValueError):
    """The request is understood but breaks a rule; the message says which."""


def slug(name: str) -> str:
    value = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:60].strip("-")  # stripped again: slug(slug(x)) == slug(x)
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
        pledge.update(statement=item.statement, source=SOURCES.get(item.source, "inferred"), confidence=item.confidence, assertion=item.assertion, reach=item.reach, trigger=item.trigger, updated_at=stamp)
        store.put("pledge", pledge)
        results.append({"pledge_id": pledge_id, "result": item.result, "kept": item.kept, "broken": item.broken, "unknown": item.unknown, "seeds": [seed.model_dump(exclude_none=True) for seed in item.seeds], "recording": item.recording.model_dump() if item.recording else None})

    run.update(phase="done", finished_at=stamp, scenario=result.scenario, faults_name=faults_name, record=result.model_dump(exclude={"pledges"}), results=results)
    store.put("run", run)
    # Findings follow the standing, which now includes this run, so they can never say something it does not.
    plans = _plans(_runs(store, repo_id))
    for item in _read(store, run)["results"]:
        finding = _update_finding(store, run, item, plans, stamp)
        if finding and item["result"] == "broken":
            finding_ids.append(finding["id"])
    if result.authoring and result.authoring.snapshot_id:
        # Where a pull request scan of this repo starts from: the app as authoring left it, booted.
        store.put("repo", {**_need(store, "repo", repo_id), "snapshot_id": result.authoring.snapshot_id, "snapshot_commit": run["commit"]})
    view = run_view(store, run)
    store.add_event(run_id, "run_finished", {"verdict": view["verdict"], "summary": view["summary"], "finding_ids": finding_ids})
    return view


def media_key(run_id: str, name: str) -> str:
    return f"run/{run_id}/{name}"


def add_media(store: Store, run_id: str, name: str, content_type: str, data: bytes, seed: int, journey: str) -> dict:
    run = _need(store, "run", run_id)
    store.put_blob(media_key(run_id, name), content_type, data)
    files = sorted({*(run.get("media") or {}).get("files", []), name})
    run["media"] = {"seed": seed, "journey": journey, "files": files}
    store.put("run", run)
    return run["media"]


def _update_finding(store: Store, run: dict, result: dict, plans: dict[str, dict], stamp: str) -> dict | None:
    """Open, reopen or verify the finding for one pledge after a run. One finding per pledge at a time."""
    pledge_id = result["pledge_id"]
    finding = next((finding for finding in store.list("finding", run["repo_id"]) if finding["pledge_id"] == pledge_id), None)
    if finding is None:
        if result["result"] != "broken":
            return None
        finding = {"id": str(uuid.uuid4()), "repo_id": run["repo_id"], "created_at": stamp, "pledge_id": pledge_id, "status": None, "first_run_id": run["id"], "faults_name": run["faults_name"], "history": []}
    before = finding["status"]
    current = _current({**finding, "status": before or "open"}, plans)
    if before is None and (current is None or current["status"] == "verified"):
        # This run broke it, but a run started after it under the same plan has already kept it: the standing
        # is kept, so there is no finding to open (and no id to hand out for one that was never stored).
        return None
    if current is None:
        return finding
    # Broke again after someone said it was fixed: their word is withdrawn, as a verified fix's is in _current.
    if result["result"] == "broken" and current["status"] == "fixed_unverified":
        current["status"] = "reopened"
    if current["status"] != before:
        current["history"] = [*finding["history"], {"at": stamp, "status": current["status"], "run_id": run["id"]}]
    if current != finding:
        current.update(statement=_need(store, "pledge", pledge_id)["statement"], updated_at=stamp)
        store.put("finding", current)
    return current


def patch_finding(store: Store, finding_id: str, patch: FindingPatch) -> dict:
    stored = _need(store, "finding", finding_id)
    finding = _current(stored, _plans(_runs(store, stored["repo_id"])))
    if finding is None:
        raise Refused("no run shows this pledge broken any more: the check never read its value, so there is nothing to fix")
    if finding["status"] == "verified":
        raise Refused("a verified finding changes only when a later run breaks the pledge again")
    if finding["status"] != patch.status:
        finding["status"] = patch.status
        finding["updated_at"] = now()
        finding["history"] = [*finding["history"], {"at": finding["updated_at"], "status": patch.status, "run_id": None}]
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


# ---------------------------------------------------------------- GitHub: installations, pull requests, jobs
# Everything below is reached from a webhook whose signature has been verified, so the caller is GitHub. The
# payload is still what a stranger can shape (a branch, a fork, a repository name), so only validated fields
# are stored, and a pull request can never attach itself to a repo it does not belong to.


def _bind_repo(store: Store, github_repo: GitHubRepo, installation_id: int) -> dict | None:
    """The repo document for a GitHub repository, created or claimed on first sight. None when its id is
    taken by something else: two full names can slug to the same id, and the second one is refused rather
    than handed the first one's pledges and findings."""
    link = {"id": github_repo.id, "full_name": github_repo.full_name, "installation_id": installation_id}
    # ponytail: scans every repo document. Give `github.id` a column when there are hundreds of repos.
    bound = next((doc for doc in store.list("repo") if (doc.get("github") or {}).get("id") == github_repo.id), None)
    doc = bound or store.get("repo", slug(github_repo.full_name))
    if doc is None:
        doc = {"id": slug(github_repo.full_name), "name": github_repo.full_name, "created_at": now()}
    elif bound is None and (doc.get("github") or doc["name"].lower() != github_repo.full_name.lower()):
        # A repo published from the command line is claimed only by the repository it was named after,
        # `pledge author --publish --app owner/name`: full names are unique on GitHub, slugs are not.
        return None
    if doc.get("github") != link:
        doc = {**doc, "github": link}
        store.put("repo", doc)
    return doc


def _cancel_queued(store: Store, repo_id: str, reason: str, status: str, pull_request: int | None = None) -> None:
    for job in store.list("job", repo_id):
        if job["status"] == "queued" and pull_request in (None, job["pull_request"]):
            store.put("job", {**job, "status": status, "reason": reason, "finished_at": now()})


def github_installation(store: Store, event: InstallationEvent) -> dict:
    """Keeps repo documents in step with where the app is installed. Removing the app keeps the repo, its
    pledges and its history; it only stops pull requests from being scanned."""
    installation_id, gone = event.installation.id, event.action in ("deleted", "suspend")
    added = [] if gone else [*event.repositories, *event.repositories_added]
    bound = [repo for repo in added if _bind_repo(store, repo, installation_id) is not None]
    removed = {repo.id for repo in event.repositories_removed}
    unbound = 0
    for doc in store.list("repo"):
        link = doc.get("github") or {}
        if link.get("installation_id") == installation_id and (gone or link.get("id") in removed):
            store.put("repo", {key: value for key, value in doc.items() if key != "github"})
            _cancel_queued(store, doc["id"], "the GitHub App was removed from this repository", "cancelled")
            unbound += 1
    return {"bound": len(bound), "refused": len(added) - len(bound), "unbound": unbound}


def github_pull_request(store: Store, event: PullRequestEvent) -> dict | None:
    """Queue one scan per pull request head commit. None when there is nothing to do."""
    if event.action not in ("opened", "synchronize", "reopened"):
        return None
    repo = _bind_repo(store, event.repository, event.installation.id)
    if repo is None:
        return None
    pull = event.pull_request
    job_id = SEP.join((repo["id"], str(pull.number), pull.head.sha))
    existing = store.get("job", job_id)
    if existing:
        return job_row(existing)  # GitHub redelivers, and reopening sends the same commit again
    _cancel_queued(store, repo["id"], "a newer commit was pushed", "superseded", pull.number)
    job = {
        "id": job_id, "repo_id": repo["id"], "created_at": now(), "repo": event.repository.full_name,
        "installation_id": event.installation.id, "pull_request": pull.number, "head_sha": pull.head.sha, "base_sha": pull.base.sha,
        # A fork's head lives in another repository (or in none, once the fork is deleted). The worker does
        # not fetch or run it; see docs/github-app.md.
        "fork": pull.head.repo is None or pull.head.repo.id != event.repository.id,
        "status": "queued", "attempts": 0, "claimed_at": None, "finished_at": None, "reason": None, "conclusion": None, "check_run_id": None, "run_ids": [],
    }
    store.put("job", job)
    return job_row(job)


def job_row(job: dict) -> dict:
    return {
        "id": job["id"], "repoId": job["repo_id"], "createdAt": job["created_at"], "finishedAt": job["finished_at"],
        "pullRequest": job["pull_request"], "headSha": job["head_sha"], "baseSha": job["base_sha"], "fork": job["fork"],
        "status": job["status"], "conclusion": job["conclusion"], "reason": job["reason"], "attempts": job["attempts"], "runIds": job["run_ids"],
    }


def job_list(store: Store, repo_id: str) -> list[dict]:
    _need(store, "repo", repo_id)
    return [job_row(job) for job in store.list("job", repo_id)]


def _stale_before() -> str:
    return (datetime.now(UTC) - timedelta(seconds=JOB_STALE_SECONDS)).isoformat()


def claim_job(store: Store) -> dict | None:
    return store.claim_job(now(), _stale_before())


def fail_stale_jobs(store: Store) -> list[dict]:
    """Jobs still running after their second hand-out went stale: nothing will pick them up again."""
    stale, failed = _stale_before(), []
    for job in store.list("job"):
        if job["status"] == "running" and job["claimed_at"] < stale and job["attempts"] >= MAX_CLAIMS:
            failed.append({**job, "status": "failed", "reason": "the worker stopped twice without finishing this job", "finished_at": now()})
            store.put("job", failed[-1])
    return failed


# ---------------------------------------------------------------- reads


def _mark(seed: dict, unfired: set[int]) -> str:
    """What one seed says about one pledge. A pass with no fault injected and a failure with no value read
    both say nothing."""
    if seed["status"] == "pass" and seed["seed"] in unfired:
        return "unknown"
    # ponytail: for runs published before the command line classified these itself (pledge.verdict.unread).
    # Only one failing sample was sent then, so only a single failed journey is known to have read nothing.
    if seed["status"] == "fail" and seed.get("failed") == 1 and seed.get("expected") is not None and seed.get("actual") is None:
        return "unknown"
    return seed["status"]


def _unfired(run: dict) -> set[int]:
    """Seeds of a run under a fault plan on which the plan injected nothing: its targets were never called.
    ponytail: counts faults per seed, not per pledge. A plan that fired only on routes a pledge does not
    depend on still counts as evidence for it; telling those apart needs the route coverage map."""
    if not run.get("faults_name"):
        return set()
    return {seed["seed"] for seed in (run.get("record") or {}).get("runs", []) if seed["faults_injected"] == 0}


def _effective(result: dict, unfired: set[int]) -> dict:
    marks = [_mark(seed, unfired) for seed in result["seeds"]]
    if marks == [seed["status"] for seed in result["seeds"]]:
        return result
    verdict = "broken" if "fail" in marks else "kept" if all(mark == "pass" for mark in marks) else "inconclusive"
    return {
        **result, "result": verdict, "kept": marks.count("pass"), "broken": marks.count("fail"), "unknown": marks.count("unknown"),
        "seeds": [{**seed, "status": mark} for seed, mark in zip(result["seeds"], marks)],
    }


def _authored(run: dict, runs: list[dict]) -> bool:
    """True when this run is the one its author's report belongs to: a first scan, and the oldest run of the
    repo carrying that report. The report sits in the app directory, so later scans published from it carried
    it too, and so did the baseline of every other scenario of the same first scan."""
    report = run["record"].get("authoring")
    if not report or run["trigger"] != "first_scan":
        return False
    return not any(other["created_at"] < run["created_at"] and other["trigger"] == "first_scan" and (other.get("record") or {}).get("authoring") == report for other in runs)


def _read(store: Store, run: dict, runs: list[dict] | None = None) -> dict:
    """A stored run as every view sees it. Idempotent, and never written back. `runs` is the repo's stored
    runs when the caller already has them."""
    if run["phase"] not in ("done", "failed"):
        # ponytail: decided when read, from the last event (the store returns the first 500 of a run; a live
        # run that has sent more and then goes quiet for two hours is the ceiling). No job sweeps these.
        events = store.events_after(run["id"], 0)
        heard = events[-1]["at"] if events else run["created_at"]
        if datetime.now(UTC) - datetime.fromisoformat(heard) > ABANDONED_AFTER:
            return {**run, "phase": "failed", "failure": "abandoned"}
        return run
    record = run.get("record")
    if not record:
        return run
    if record.get("authoring") and not _authored(run, store.list("run", run["repo_id"]) if runs is None else runs):
        record = {**record, "authoring": None}
    unfired = _unfired(run)
    return {**run, "record": record, "results": [_effective(result, unfired) for result in run["results"]]}


def _runs(store: Store, repo_id: str) -> list[dict]:
    runs = store.list("run", repo_id)
    return [_read(store, run, runs) for run in runs]


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
        "authored": bool((run.get("record") or {}).get("authoring")), "unfiredSeeds": sorted(_unfired(run)),
    }


def run_view(store: Store, run: dict) -> dict:
    run = _read(store, run)
    pledges = _pledges(store, run["repo_id"])
    record = run.get("record") or {}
    unfired = _unfired(run)
    results = [
        {**result, "pledgeId": result["pledge_id"], "statement": pledges[result["pledge_id"]]["statement"], "status": pledges[result["pledge_id"]]["status"]}
        for result in run["results"] if result["pledge_id"] in pledges
    ]
    findings = [finding["id"] for finding in store.list("finding", run["repo_id"]) if finding.get("run_id") == run["id"]]
    return {
        **run_row(run, pledges),
        "results": sorted(results, key=lambda result: result["result"] != "broken"),
        "faultPlan": record.get("faults"), "sandbox": record.get("sandbox"),
        "seedRuns": [{**seed, "limitations": [UNFIRED_NOTE, *seed["limitations"]]} if seed["seed"] in unfired else seed for seed in record.get("runs", [])],
        "authoring": record.get("authoring"), "env": record.get("env", {}), "findingIds": findings,
    }


def _plans(runs: list[dict]) -> dict[str, dict[str | None, dict]]:
    """Each pledge's latest conclusive result under each fault plan (None is the baseline). `runs` is newest
    first. A run that came back inconclusive settles nothing, so it stands only where no kept or broken run
    under the same plan exists.
    ponytail: a plan that is renamed or deleted keeps its last result for good; drop plans the repo no longer
    has once runs carry the list of fault files."""
    plans: dict[str, dict[str | None, dict]] = {}
    for run in runs:
        if run["phase"] != "done":
            continue
        for result in run["results"]:
            mine = plans.setdefault(result["pledge_id"], {})
            current = mine.get(run["faults_name"])
            if current is None or (current["result"] == "inconclusive" and result["result"] != "inconclusive"):
                mine[run["faults_name"]] = {**result, "run_id": run["id"], "faults": run["faults_name"], "at": run["created_at"]}
    return plans


def _standing(plans: dict[str, dict[str | None, dict]]) -> dict[str, dict]:
    """Each pledge's standing: the worst of its plans, so broken under any plan is broken. Among equals the
    newest run speaks, and a kept run under faults says more than a kept baseline."""
    return {
        pledge_id: min(sorted(mine.values(), key=lambda entry: entry["at"], reverse=True), key=lambda entry: (RANK[entry["result"]], entry["faults"] is None))
        for pledge_id, mine in plans.items()
    }


def _current(finding: dict, plans: dict[str, dict]) -> dict | None:
    """A finding as the runs have it now, or None when no run shows its pledge broken or fixed: the failure
    it was opened for has since been read as unknown, so there is nothing to report."""
    mine = plans.get(finding["pledge_id"], {})
    broken = [entry for entry in mine.values() if entry["result"] == "broken"]
    if broken:
        last = max(broken, key=lambda entry: entry["at"])
        return {
            **finding, "status": "reopened" if finding["status"] == "verified" else finding["status"], "run_id": last["run_id"], "faults_name": last["faults"],
            "broken_seeds": [seed["seed"] for seed in last["seeds"] if seed["status"] == "fail"], "total_seeds": len(last["seeds"]),
        }
    # Verified only by evidence: the plan that broke it now keeps it. A kept run under another plan says nothing.
    proof = mine.get(finding.get("faults_name"))
    if proof and proof["result"] == "kept":
        return {**finding, "status": "verified", "verified_run_id": proof["run_id"]}
    return None


def _findings(store: Store, repo_id: str, plans: dict[str, dict], pledges: dict[str, dict]) -> list[dict]:
    """The findings there are to act on or to have fixed. A retired pledge is no longer a rule and no run
    checks it again, so its finding could never close; it is left out with the pledge."""
    found = (_current(finding, plans) for finding in store.list("finding", repo_id) if pledges.get(finding["pledge_id"], {}).get("status") != "retired")
    return [finding for finding in found if finding]


def _history(runs: list[dict], pledge_id: str) -> list[dict]:
    points = []
    for run in runs:
        for result in run["results"]:
            if result["pledge_id"] == pledge_id:
                points.append({"runId": run["id"], "at": run["created_at"], "faults": run["faults_name"], "result": result["result"]})
    return points[:HISTORY_RUNS]


def pledge_row(pledge: dict, standing: dict[str, dict]) -> dict:
    last = standing.get(pledge["id"])
    return {
        "id": pledge["id"], "repoId": pledge["repo_id"], "key": pledge["key"], "scenario": pledge["scenario"], "statement": pledge["statement"],
        "status": pledge["status"], "source": pledge["source"], "sourceRef": None, "confidence": pledge["confidence"],
        "reach": pledge.get("reach", "unknown"), "trigger": pledge.get("trigger", ""),  # absent on pledges stored before these fields
        "plantedBugsCaught": pledge["planted_bugs_caught"], "lastVerdict": last["result"] if last else None,
        "lastRunId": last["run_id"] if last else None, "lastFaults": last["faults"] if last else None,
        "lastSeeds": [seed["status"] for seed in last["seeds"]] if last else [], "decision": pledge.get("decision"),
    }


def pledge_list(store: Store, repo_id: str, status: str | None = None) -> list[dict]:
    _need(store, "repo", repo_id)
    standing = _standing(_plans(_runs(store, repo_id)))
    order = {"broken": 0, "inconclusive": 1, "kept": 2, None: 3}
    rows = [pledge_row(pledge, standing) for pledge in store.list("pledge", repo_id) if status is None or pledge["status"] == status]
    return sorted(rows, key=lambda row: (order[row["lastVerdict"]], row["scenario"], row["key"]))


def pledge_view(store: Store, pledge: dict) -> dict:
    runs = _runs(store, pledge["repo_id"])
    plans = _plans(runs)
    standing = _standing(plans)
    last = standing.get(pledge["id"])
    finding = next((f for f in _findings(store, pledge["repo_id"], plans, {}) if f["pledge_id"] == pledge["id"]), None)
    return {
        **pledge_row(pledge, standing), "assertion": pledge["assertion"], "file": f".pledge/pledges/{pledge['key']}.json",
        "seeds": last["seeds"] if last else [], "history": _history(runs, pledge["id"]),
        "findingId": finding["id"] if finding else None, "plantedBugs": [],
    }


def _replay(scenario: str, faults_name: str | None, seed: int) -> str:
    faults = f" --faults .pledge/faults/{faults_name}.json" if faults_name else ""
    return f"pledge run . --scenario {scenario}{faults} --seed {seed}"


MONEY = re.compile(r"charg|payment|pay\b|paid|revenue|refund|price|amount|balance|invoice|credit|debit|psp|capture|money|billing|total")
DUPLICATE = re.compile(r"once|twice|duplicat|exactly one|single|\bone\b|unique|double")
SEVERITY_ORDER = {"money": 0, "duplicate": 1, "data": 2}


def severity(key: str, statement: str) -> str:
    """Money first, then duplicated records, then other wrong data: the order a lead triages in.
    ponytail: keyword match on the pledge's words; a severity field the author writes would be exact."""
    text = f"{key} {statement}".lower()
    return "money" if MONEY.search(text) else "duplicate" if DUPLICATE.search(text) else "data"


def _first_broken(store: Store, finding: dict) -> dict:
    """The first failing seed of the run that last broke this finding's pledge: where its numbers come from."""
    result = next((item for item in _run(store, finding["run_id"])["results"] if item["pledge_id"] == finding["pledge_id"]), {"seeds": []})
    return next((seed for seed in result["seeds"] if seed["status"] == "fail"), {})


def _run(store: Store, run_id: str) -> dict:
    run = store.get("run", run_id)
    return _read(store, run) if run else {"results": [], "record": None, "scenario": None, "phase": "done"}


def finding_row(store: Store, finding: dict, pledges: dict[str, dict]) -> dict:
    pledge = pledges.get(finding["pledge_id"], {})
    broken = _first_broken(store, finding)
    return {
        "id": finding["id"], "repoId": finding["repo_id"], "pledgeId": finding["pledge_id"], "pledgeKey": pledge.get("key"),
        "pledgeStatus": pledge.get("status"), "statement": finding["statement"], "status": finding["status"], "runId": finding["run_id"],
        "brokenSeeds": finding["broken_seeds"], "totalSeeds": finding["total_seeds"], "faults": finding.get("faults_name"),
        "firstSeen": finding["created_at"], "updatedAt": finding["updated_at"],
        "severity": severity(pledge.get("key") or "", finding["statement"]),
        "reach": pledge.get("reach", "unknown"), "trigger": pledge.get("trigger", ""),
        "expected": broken.get("expected"), "actual": broken.get("actual"),
    }


def finding_list(store: Store, repo_id: str, status: str | None = None) -> list[dict]:
    _need(store, "repo", repo_id)
    pledges = _pledges(store, repo_id)
    rows = [finding_row(store, finding, pledges) for finding in _findings(store, repo_id, _plans(_runs(store, repo_id)), pledges) if status is None or finding["status"] == status]
    return sorted(rows, key=lambda row: (row["status"] == "verified", REACH_ORDER[row["reach"]], SEVERITY_ORDER[row["severity"]]))  # stable: newest first within a level


def finding_view(store: Store, finding: dict) -> dict:
    pledges = _pledges(store, finding["repo_id"])
    # A finding no run supports any more is still shown as it was stored, to whoever holds its link.
    finding = _current(finding, _plans(_runs(store, finding["repo_id"]))) or finding
    run = _run(store, finding["run_id"])
    result = next((item for item in run["results"] if item["pledge_id"] == finding["pledge_id"]), {"seeds": []})
    recording = result.get("recording")
    record = run.get("record") or {}
    return {
        **finding_row(store, finding, pledges),
        "seeds": result["seeds"],
        "summary": _summary(run) if run.get("record") else None, "faultPlan": record.get("faults"),
        # The recording is one broken journey as the proxy saw it; runs from before the proxy logged traffic have none.
        # Nothing shrinks a fault plan yet, so that stays empty rather than invented.
        "timeline": recording["steps"] if recording else [], "recording": recording and {key: recording[key] for key in ("seed", "journey", "faults_hit")},
        # A browser recording of what the broken journey's user sees, when the scenario has browser steps.
        "browser": run.get("media") and {**run["media"], "runId": run["id"]},
        "minimalFaultPlan": [],
        "replayCommand": _replay(run.get("scenario") or "", finding.get("faults_name"), recording["seed"] if recording else (finding["broken_seeds"] or [1])[0]),
        "history": finding["history"], "blocks": pledges.get(finding["pledge_id"], {}).get("status") == "approved",
    }


def repo_list(store: Store) -> list[dict]:
    rows = []
    for repo in store.list("repo"):
        pledges = _pledges(store, repo["id"])
        runs = _runs(store, repo["id"])
        latest = next((run for run in runs if run["phase"] == "done"), None)
        rows.append({
            "id": repo["id"], "name": repo["name"], "createdAt": repo["created_at"], "pledges": len(pledges),
            "openFindings": sum(1 for finding in _findings(store, repo["id"], _plans(runs), pledges) if finding["status"] != "verified"),
            "latestRun": run_row(latest, pledges) if latest else None, "lastActivity": runs[0]["created_at"] if runs else repo["created_at"],
        })
    return sorted(rows, key=lambda row: row["lastActivity"], reverse=True)


def overview(store: Store, repo_id: str) -> dict:
    repo = _need(store, "repo", repo_id)
    pledges = _pledges(store, repo_id)
    runs = _runs(store, repo_id)
    plans = _plans(runs)
    findings = _findings(store, repo_id, plans, pledges)
    standing = _standing(plans)
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
        "latestFindings": finding_list(store, repo_id)[:LATEST],
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
