"""`pledge worker`: takes queued pull request jobs one at a time, scans each and reports back to GitHub.

    DATABASE_URL=... GITHUB_APP_ID=... GITHUB_APP_PRIVATE_KEY=... E2B_API_KEY=... pledge worker

One job: mark a check run in progress, fetch the repository at the pull request's head, work out which
scenarios the diff touches, scan those, record each scan as a run exactly as `pledge scan --publish` would,
then conclude the check and keep one comment up to date. The check fails only if an approved pledge broke.

The worker holds the GitHub App key and the E2B key. The sandbox that runs the pull request's code holds
neither, and has no way out to fetch anything.
"""

from __future__ import annotations

import logging
import os
import tempfile
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from pledge import pr
from pledge.api import logic
from pledge.api.models import EventIn, RunResultIn, RunStartIn
from pledge.api.store import Store, now
from pledge.github import API, GitHub, GitHubError, app_jwt, extract_tarball

log = logging.getLogger("pledge.worker")
SEEDS = 5
MAX_RUNS = 4  # scans per job; each is SEEDS sandboxes
IDLE_SECONDS = 5
COULD_NOT_RUN = "Pledge could not run"
FORK_NOTE = "This pull request comes from a fork. Pledge does not fetch or run a fork's code yet, so nothing was checked."


@dataclass(frozen=True)
class ScanRequest:
    app_dir: Path  # the repository at the pull request's head
    scenario: str
    faults: Path | None
    snapshot: str | None  # the repo's saved, booted sandbox, from the commit it was authored on
    removed: tuple[str, ...]  # files the pull request deletes, which a tree laid over the snapshot would leave behind


Scan = Callable[[ScanRequest], dict]  # returns the record `pledge.publish.build_record` builds


def scan_report(request: ScanRequest, runs_dir: Path, scan: Callable[..., dict]) -> dict:
    """Boot at this commit the cheapest way that is still the pull request's code: restore the snapshot and
    restart the app on the new tree; if it will not restart, boot the tree from cold."""
    from pledge.scan import RebootFailed

    if request.snapshot:
        try:
            return scan(request.app_dir, request.scenario, request.faults, SEEDS, {}, runs_dir, request.snapshot, None, list(request.removed))
        except RebootFailed:
            log.info("restart from the snapshot failed, booting from cold")  # no detail: it quotes the sandbox
    # ponytail: a cold boot installs nothing, so it only works for an app whose dependencies are in the base
    # template. Anything else fails here and the check says Pledge could not run. The fix is a boot recipe that
    # carries its install steps, replayed with registries open, as authoring's boot phase does by hand.
    return scan(request.app_dir, request.scenario, request.faults, SEEDS, {}, runs_dir, None, None, None)


def real_scan(request: ScanRequest) -> dict:
    """E2B CALL SITE: the only path from the worker to a sandbox. Tests inject a stand-in instead."""
    from pledge.publish import build_record
    from pledge.scan import scan

    runs_dir = request.app_dir.parent / "runs" / f"{request.scenario}-{request.faults.stem if request.faults else 'baseline'}"
    report = scan_report(request, runs_dir, scan)
    return build_record(request.app_dir, report, [Path(path) for path in report["run_dirs"]], request.faults, {})


def plan(app_dir: Path, diff: str) -> tuple[list[tuple[str, Path | None]], dict]:
    """Which (scenario, fault plan) pairs to scan for this diff, and what the matching found."""
    scenarios, pledges = pr.load(app_dir)
    touched = pr.touched_scenarios(diff, scenarios, pledges)
    # A change Pledge cannot place could be to anything, so every scenario runs.
    names = sorted(scenarios) if touched["unmatched"] else list(touched["scenarios"])
    pairs = [(name, faults) for name in names for faults in (pr.faults_for(scenarios[name], app_dir) or [None])]
    return pairs, touched


def _conclude(store: Store, job: dict, github: GitHub | None, status: str, conclusion: str, title: str, summary: str, reason: str | None = None) -> dict:
    job = {**job, "status": status, "conclusion": conclusion, "reason": reason, "finished_at": now()}
    store.put("job", job)
    if github and job["check_run_id"]:
        github.complete_check_run(job["repo"], job["check_run_id"], conclusion, title, summary)
    return job


def run_job(store: Store, job: dict, github_for: Callable[[dict], GitHub], scan: Scan, public_url: str) -> dict:
    """Do one claimed job to the end. Whatever goes wrong, the job is marked and the check run is concluded."""
    github, open_run = None, None
    try:
        github = github_for(job)
        if not job["check_run_id"]:  # a job handed out a second time already has one
            job = {**job, "check_run_id": github.create_check_run(job["repo"], job["head_sha"])}
            store.put("job", job)
        if job["fork"]:
            return _conclude(store, job, github, "skipped", "neutral", "Not run: pull request from a fork", FORK_NOTE, "fork")
        repo = logic._need(store, "repo", job["repo_id"])
        with tempfile.TemporaryDirectory(prefix="pledge-job-") as scratch:  # the source is gone when the job is
            app_dir = extract_tarball(github.tarball(job["repo"], job["head_sha"]), Path(scratch) / "tree")
            if not (app_dir / ".pledge" / "scenarios").is_dir():
                return _conclude(store, job, github, "skipped", "neutral", "Not run: no scenarios in this repository", "This commit has no `.pledge/scenarios`. Run a first scan and commit the files it writes.", "no scenarios")
            diff = github.diff(job["repo"], job["pull_request"])
            pairs, touched = plan(app_dir, diff)
            if not pairs:
                return _conclude(store, job, github, "done", "neutral", "No scenario is touched by this change", "Pledge matched the changed files against the routes each scenario calls and found none to run.")
            views = []
            for scenario, faults in pairs[:MAX_RUNS]:
                open_run = logic.start_run(store, job["repo_id"], RunStartIn(trigger="pull_request", phase="run", scenario=scenario, commit=job["head_sha"], pull_request=job["pull_request"], seeds=SEEDS))
                job = {**job, "run_ids": [*job["run_ids"], open_run["id"]]}
                store.put("job", job)
                record = scan(ScanRequest(app_dir, scenario, faults, repo.get("snapshot_id"), tuple(touched["removed"])))
                # A pledge first seen in a pull request is proposed, whatever status its file claims: the files
                # are the pull request author's, and only a person in the dashboard approves. (A pledge the
                # catalogue already knows keeps the status decided there; finish_run ignores the file's.)
                # `authoring` is dropped for the same reason: build_record reads it from a file in the tree, and
                # finish_run would save the snapshot it names as the one every later scan of this repo restores.
                record = {**record, "authoring": None, "pledges": [{**pledge, "status": "proposed"} for pledge in record["pledges"]]}
                views.append(logic.finish_run(store, open_run["id"], RunResultIn.model_validate(record)))
                open_run = None
        broken = sum(1 for view in views if view["verdict"] == "broken")
        markdown = "\n\n---\n\n".join(logic.pr_comment(store, logic._need(store, "run", view["id"]), public_url) for view in views)
        if len(pairs) > MAX_RUNS:
            markdown += f"\n\n{len(pairs) - MAX_RUNS} more scenario and fault plan pairs were touched and not run: a pull request gets at most {MAX_RUNS} scans."
        own = sorted({changed["path"] for changed in pr.parse_diff(diff) if changed["path"].startswith(".pledge/")})
        if own:
            # The scenarios and pledge files that ran are the pull request's own, so a change to them can make a
            # pledge pass by checking less. Code cannot tell; the reviewer is told.
            markdown += f"\n\n**This pull request changes Pledge's own files** ({len(own)} under `.pledge/`, such as `{own[0][:200]}`). The checks ran as this pull request defines them: review those changes as you would a change to a test."
        try:
            github.upsert_comment(job["repo"], job["pull_request"], markdown)
        except GitHubError as exc:
            # The check below carries the same text and the verdict. Losing the comment must not turn a
            # broken approved pledge into "Pledge could not run".
            log.warning("job %s: the comment was not posted: %s", job["id"], exc)
        title ="An approved pledge broke" if broken else f"No approved pledge broke ({len(views)} scans)"
        return _conclude(store, job, github, "done", "failure" if broken else "neutral", title, markdown)
    except Exception as exc:  # noqa: BLE001 - a job never takes the worker down, and its check never stays in progress
        log.warning("job %s failed: %s", job["id"], type(exc).__name__)  # the type only: a message can quote a sandbox
        reason = f"{type(exc).__name__}: {exc}"[:500]
        if open_run:
            logic.record_event(store, open_run["id"], EventIn(type="run_finished", payload={"failed": reason}))
        try:
            # The reason stays in the dashboard. The check is public on a public repository and says only this.
            return _conclude(store, job, github, "failed", "neutral", COULD_NOT_RUN, "Pledge could not run on this pull request. The reason is in the Pledge dashboard.", reason)
        except GitHubError:
            return {**job, "status": "failed", "reason": reason}


def work(store: Store, github_for: Callable[[dict], GitHub], scan: Scan, public_url: str, once: bool = False) -> None:
    """Claim and run jobs until stopped. `once` returns when the queue is empty, for tests and one-off runs."""
    while True:
        for lost in logic.fail_stale_jobs(store):
            try:
                if lost["check_run_id"]:
                    github_for(lost).complete_check_run(lost["repo"], lost["check_run_id"], "neutral", COULD_NOT_RUN, "Pledge stopped twice while running this pull request.")
            except Exception:  # noqa: BLE001 - best effort; the job is already marked
                log.warning("could not conclude the check run of lost job %s", lost["id"])
        job = logic.claim_job(store)
        if job is not None:
            log.info("job %s: pull request %s at %s", job["id"], job["pull_request"], job["head_sha"][:12])
            done = run_job(store, job, github_for, scan, public_url)
            log.info("job %s: %s", job["id"], done["status"])
        elif once:
            return
        else:
            time.sleep(IDLE_SECONDS)


def main() -> int:
    """Everything from the environment, and a refusal to start that names what is missing."""
    from pledge.api.store import PgStore

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    needed = ("DATABASE_URL", "GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", "E2B_API_KEY")
    missing = [name for name in needed if not os.environ.get(name)]
    if missing:
        raise SystemExit(f"pledge worker: {', '.join(missing)} must be set")
    app_id = os.environ["GITHUB_APP_ID"]
    private_key = os.environ["GITHUB_APP_PRIVATE_KEY"].replace("\\n", "\n")  # a PEM pasted into a one-line field
    base_url = os.environ.get("GITHUB_API_URL", API)

    def github_for(job: dict) -> GitHub:
        # A fresh token per job, good for an hour and for this one repository.
        repository_id = ((store.get("repo", job["repo_id"]) or {}).get("github") or {}).get("id")
        return GitHub(GitHub(app_jwt(app_id, private_key), base_url).installation_token(job["installation_id"], repository_id), base_url)

    store = PgStore(os.environ["DATABASE_URL"])
    store.migrate()
    work(store, github_for, real_scan, os.environ.get("PLEDGE_PUBLIC_URL", "https://app.pledge.sh"))
    return 0
