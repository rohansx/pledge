"""The pull request worker with a stand-in GitHub on a local port and a stand-in scan: no E2B, no network."""

import json
import threading
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from fake_github import BASE_SHA, SHA, FakeGitHub, tarball

from pledge import scan as scan_module
from pledge import worker
from pledge.api import logic
from pledge.api.models import PledgePatch, PullRequestEvent, RunResultIn, RunStartIn
from pledge.api.store import MemoryStore
from pledge.github import MARKER, GitHub

DIFF = "diff --git a/src/payments.py b/src/payments.py\n--- a/src/payments.py\n+++ b/src/payments.py\n@@ -1 +1 @@\n-charge(order)\n+charge(order, key)\n"
TREE = {
    "src/payments.py": "def charge(order, key): ...\n",
    ".pledge/scenarios/checkout/manifest.json": json.dumps({"schema_version": 1, "name": "checkout", "script": "journeys.js", "assertions": ["one_charge"]}),
    ".pledge/scenarios/checkout/journeys.js": 'http.post(`${__ENV.LT_TARGET}/payments`, body);\n',
    ".pledge/pledges/one-charge.json": json.dumps({"schema_version": 1, "id": "one-charge", "statement": "An order is charged once.", "check": {"scenario": "checkout", "assertion": "one_charge"}, "source": "domain_template", "confidence": "high", "status": "approved"}),
    ".pledge/faults/lost-reply.json": json.dumps({"description": "Replies are lost.", "faults": [{"kind": "retry", "target": "app POST /payments", "params": {"rate": 0.5}}]}),
}


def record(result: str = "kept", status: str = "approved") -> dict:
    mark = "fail" if result == "broken" else "pass"
    return {
        "schema_version": 1, "scenario": "checkout", "env": {}, "authoring": None, "sandbox": {"template": "snap:default", "outbound_blocked": True, "seconds": {"total": 30.0}},
        "faults": {"name": "lost-reply", "description": "Replies are lost.", "faults": [{"kind": "retry", "target": "app POST /payments", "params": {"rate": 0.5}}]},
        "pledges": [{"id": "one-charge", "statement": "An order is charged once.", "status": status, "source": "domain_template", "confidence": "high", "assertion": "one_charge", "result": result,
                     "kept": int(mark == "pass"), "broken": int(mark == "fail"), "unknown": 0, "seeds": [{"seed": 1, "run_id": "r1", "status": mark}]}],
        "runs": [{"seed": 1, "run_id": "r1", "verdict": mark, "faults_injected": 4, "journeys": 20, "requests": 60, "unexpected_failures": 0, "limitations": []}],
    }


@pytest.fixture
def fake():
    server = FakeGitHub()
    server.diff, server.tree = DIFF, tarball(TREE)
    yield server
    server.close()


@pytest.fixture
def store():
    return MemoryStore()


def queue(store, sha: str = SHA, number: int = 3, head_repo: int | None = 99) -> dict:
    event = {"action": "opened", "pull_request": {"number": number, "head": {"sha": sha, "repo": head_repo and {"id": head_repo}}, "base": {"sha": BASE_SHA}}, "repository": {"id": 99, "full_name": "o/r"}, "installation": {"id": 7}}
    logic.github_pull_request(store, PullRequestEvent.model_validate(event))
    return store.get("job", f"o-r~{number}~{sha}")


def approve(store) -> None:
    """A first scan from the command line, then a person approving its pledge in the dashboard."""
    run = logic.start_run(store, "o/r", RunStartIn())
    logic.finish_run(store, run["id"], RunResultIn.model_validate(record("kept", status="proposed")))
    logic.patch_pledge(store, "o-r~checkout~one-charge", PledgePatch(action="approve", override=True))


def run(store, fake, scan, sha: str = SHA) -> dict:
    job = logic.claim_job(store)
    return worker.run_job(store, job, lambda _: GitHub("installation-token", fake.url), scan, "https://app.example")


def test_a_job_scans_the_touched_scenario_and_reports_a_neutral_check_and_one_comment(store, fake):
    queue(store)
    requests = []

    def scan(request: worker.ScanRequest) -> dict:
        assert (request.app_dir / "src" / "payments.py").read_text() == TREE["src/payments.py"]  # the pull request's tree
        assert fake.checks[100]["status"] == "in_progress"  # GitHub already shows the check running
        requests.append(request)
        return record("kept")

    job = run(store, fake, scan)

    assert [(r.scenario, r.faults.name, r.snapshot, r.removed) for r in requests] == [("checkout", "lost-reply.json", None, ())]
    assert not requests[0].app_dir.exists()  # the source is deleted with the job
    assert (job["status"], job["conclusion"], job["reason"]) == ("done", "neutral", None) and store.get("job", job["id"]) == job
    check = fake.checks[100]
    assert (check["head_sha"], check["status"], check["conclusion"], check["output"]["title"]) == (SHA, "completed", "neutral", "No approved pledge broke (1 scans)")
    assert [comment["body"].splitlines()[:2] for comment in fake.comments] == [[MARKER, "**Pledge: no approved pledge broken** (1 checked)"]]
    stored = store.get("run", job["run_ids"][0])
    assert (stored["trigger"], stored["commit"], stored["pull_request"], stored["phase"], stored["faults_name"]) == ("pull_request", SHA, 3, "done", "lost-reply")
    assert {call["auth"] for call in fake.calls} == {"Bearer installation-token"}


def test_the_check_fails_only_when_an_approved_pledge_broke(store, fake):
    queue(store)
    assert run(store, fake, lambda _: record("broken"))["conclusion"] == "neutral"  # broken, but nobody approved it
    assert "For review" in fake.comments[0]["body"]

    approve(store)
    queue(store, sha="c" * 40)
    fake.commits.add("c" * 40)
    job = run(store, fake, lambda _: record("broken"))

    assert job["conclusion"] == "failure"
    check = fake.checks[101]
    assert (check["conclusion"], check["output"]["title"]) == ("failure", "An approved pledge broke")
    assert len(fake.comments) == 1 and "**Pledge: 1 of 1 pledges broken**" in fake.comments[0]["body"]  # the one comment, edited
    assert "View finding" in check["output"]["summary"]


def test_a_pledge_first_seen_in_a_pull_request_is_proposed_whatever_its_file_says(store, fake):
    queue(store)

    job = run(store, fake, lambda _: record("broken", status="approved"))  # the pull request's own file says "approved"

    assert store.get("pledge", "o-r~checkout~one-charge")["status"] == "proposed"
    assert job["conclusion"] == "neutral"


def test_a_job_that_raises_is_failed_with_the_reason_and_its_check_says_only_that_pledge_could_not_run(store, fake):
    queue(store)

    def scan(_: worker.ScanRequest) -> dict:
        raise RuntimeError("in sandbox, `pledge boot app` exited 1: DATABASE_PASSWORD=hunter2 refused")

    job = run(store, fake, scan)

    assert job["status"] == "failed" and job["reason"].startswith("RuntimeError: in sandbox, `pledge boot app` exited 1")
    check = fake.checks[100]
    assert (check["status"], check["conclusion"], check["output"]["title"]) == ("completed", "neutral", "Pledge could not run")
    assert "hunter2" not in json.dumps(fake.checks) and fake.comments == []  # the reason stays in the dashboard
    failed = store.get("run", job["run_ids"][0])
    assert failed["phase"] == "failed" and "exited 1" in failed["failure"]


def test_a_job_whose_installation_token_is_refused_is_failed_without_a_check_run(store, fake):
    queue(store)
    job = logic.claim_job(store)

    def no_token(_: dict) -> GitHub:
        return GitHub(GitHub("app.jwt", fake.url).installation_token(7), fake.url)

    fake.fail["POST /app/installations"] = 401
    done = worker.run_job(store, job, no_token, lambda _: record(), "https://app.example")

    assert (done["status"], store.get("job", job["id"])["status"]) == ("failed", "failed") and "401" in done["reason"]
    assert fake.checks == {}


def test_a_pull_request_from_a_fork_gets_a_neutral_check_and_its_code_is_never_fetched(store, fake):
    queue(store, head_repo=4242)
    scans = []

    job = run(store, fake, scans.append)

    assert (job["status"], job["conclusion"], job["reason"]) == ("skipped", "neutral", "fork")
    assert fake.checks[100]["output"]["title"] == "Not run: pull request from a fork"
    assert scans == [] and fake.paths("GET") == [] and fake.comments == []


def test_a_change_that_touches_no_scenario_runs_nothing(store, fake):
    queue(store)
    fake.diff = "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-old\n+new\n"
    scans = []

    job = run(store, fake, scans.append)

    assert (job["status"], job["conclusion"], job["run_ids"]) == ("done", "neutral", []) and scans == []
    assert fake.checks[100]["output"]["title"] == "No scenario is touched by this change"


def test_a_repository_with_no_scenarios_is_skipped_with_a_note_on_what_to_do(store, fake):
    queue(store)
    fake.tree = tarball({"src/payments.py": "x"})

    job = run(store, fake, lambda _: record())

    assert (job["status"], job["reason"]) == ("skipped", "no scenarios") and "first scan" in fake.checks[100]["output"]["summary"]


def test_a_change_pledge_cannot_place_runs_every_scenario_and_passes_on_deleted_files(store, fake):
    queue(store)
    logic.finish_run(store, logic.start_run(store, "o/r", RunStartIn())["id"], RunResultIn.model_validate({**record(), "authoring": {"seconds": 1.0, "phases": [], "summary": "", "open_questions": [], "snapshot_id": "snap:default"}}))
    fake.diff = "diff --git a/lib/retry.py b/lib/retry.py\ndeleted file mode 100644\n--- a/lib/retry.py\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n"
    requests = []

    run(store, fake, lambda request: requests.append(request) or record())

    assert [(r.scenario, r.snapshot, r.removed) for r in requests] == [("checkout", "snap:default", ("lib/retry.py",))]


def test_jobs_are_claimed_oldest_first_and_each_by_one_worker_only(store):
    for number in range(1, 9):
        queue(store, sha=f"{number}" * 40, number=number)
    claimed, lock = [], threading.Lock()

    def claim() -> None:
        job = logic.claim_job(store)
        with lock:
            claimed.append(job)

    threads = [threading.Thread(target=claim) for _ in range(12)]
    [thread.start() for thread in threads]
    [thread.join() for thread in threads]

    got = [job for job in claimed if job]
    assert len(got) == 8 and len({job["id"] for job in got}) == 8 and claimed.count(None) == 4
    assert all((job["status"], job["attempts"]) == ("running", 1) for job in got)

    fresh = MemoryStore()
    queue(fresh, sha="1" * 40, number=1)
    queue(fresh, sha="2" * 40, number=2)
    assert [logic.claim_job(fresh)["pull_request"], logic.claim_job(fresh)["pull_request"], logic.claim_job(fresh)] == [1, 2, None]


def test_a_job_stuck_running_for_over_an_hour_is_handed_out_once_more_and_then_failed(store, fake):
    queue(store)

    def age(job: dict) -> None:
        store.put("job", {**job, "claimed_at": (datetime.now(UTC) - timedelta(minutes=61)).isoformat()})

    first = logic.claim_job(store)
    assert logic.claim_job(store) is None  # running, and not for long: nobody else takes it
    age(first)
    second = logic.claim_job(store)
    assert (second["id"], second["attempts"]) == (first["id"], 2)
    assert logic.fail_stale_jobs(store) == []

    age({**second, "check_run_id": GitHub("t", fake.url).create_check_run("o/r", SHA)})
    assert logic.claim_job(store) is None  # twice is enough
    worker.work(store, lambda _: GitHub("t", fake.url), lambda _: record(), "https://app.example", once=True)

    job = store.get("job", first["id"])
    assert (job["status"], job["reason"]) == ("failed", "the worker stopped twice without finishing this job")
    assert (fake.checks[100]["conclusion"], fake.checks[100]["output"]["title"]) == ("neutral", "Pledge could not run")


def test_the_worker_loop_drains_the_queue_and_survives_a_failing_job(store, fake):
    queue(store, sha="c" * 40, number=3)
    queue(store, number=4)
    # The stand-in serves a tarball for SHA only, so the first job's fetch is a 404.

    worker.work(store, lambda _: GitHub("t", fake.url), lambda _: record(), "https://app.example", once=True)

    assert sorted((job["pull_request"], job["status"]) for job in store.list("job")) == [(3, "failed"), (4, "done")]
    assert [check["conclusion"] for check in fake.checks.values()] == ["neutral", "neutral"]
    assert logic.claim_job(store) is None


def test_a_snapshot_that_will_not_restart_on_the_new_code_falls_back_to_a_cold_boot(tmp_path):
    calls = []

    def scan(app_dir, scenario, faults, seeds, env, runs_dir, snapshot, on_seed, removed):
        calls.append((snapshot, removed))
        if snapshot:
            raise scan_module.RebootFailed("the app did not restart at this commit")
        return {"verdict": "kept"}

    request = worker.ScanRequest(tmp_path, "checkout", None, "snap:default", ("gone.py",))

    assert worker.scan_report(request, tmp_path / "runs", scan) == {"verdict": "kept"}
    assert calls == [("snap:default", ["gone.py"]), (None, None)]

    calls.clear()
    worker.scan_report(worker.ScanRequest(tmp_path, "checkout", None, None, ()), tmp_path / "runs", scan)
    assert calls == [(None, None)]  # no snapshot saved for this repo: cold from the start


def test_booting_at_a_commit_stops_the_app_lays_the_tree_over_it_deletes_and_restarts(tmp_path):
    ran = []

    def sh(sandbox, command, timeout=300):
        ran.append(command.replace(scan_module.PLEDGE, "pledge"))
        return ""

    scan_module.boot_at_commit("sandbox", tmp_path, ["lib/old name.py", "-rf"], sh=sh, upload=lambda sandbox, directory, destination: ran.append(f"upload {destination}"))

    assert ran[:4] == ["pledge down app", "upload /work/app", "cd /work/app && rm -f -- 'lib/old name.py' -rf", "pledge boot app"]
    assert "does not answer" in ran[4]  # then the check that the app answers through the proxy


def test_booting_at_a_commit_refuses_a_deleted_path_outside_the_app_and_reports_a_failed_restart(tmp_path):
    ran = []
    for path in ("../../etc/passwd", "/etc/passwd", "a/../../b"):
        with pytest.raises(scan_module.RebootFailed):
            scan_module.boot_at_commit("sandbox", tmp_path, [path], sh=lambda *a, **k: ran.append(a), upload=lambda *a: ran.append(a))
    assert ran == []

    def sh(sandbox, command, timeout=300):
        if "boot app" in command:
            raise RuntimeError("in sandbox, `pledge boot app` exited 1: app: not healthy")
        return ""

    with pytest.raises(scan_module.RebootFailed, match="did not restart at this commit"):
        scan_module.boot_at_commit("sandbox", tmp_path, [], sh=sh, upload=lambda *a: None)


def test_the_worker_refuses_to_start_and_names_what_is_missing(monkeypatch):
    for name in ("DATABASE_URL", "GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", "E2B_API_KEY"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("GITHUB_APP_ID", "12345")

    with pytest.raises(SystemExit, match="DATABASE_URL, GITHUB_APP_PRIVATE_KEY, E2B_API_KEY must be set"):
        worker.main()


def test_the_scan_plan_pairs_each_touched_scenario_with_the_fault_plans_that_hit_its_routes(tmp_path):
    for path, text in {**TREE, ".pledge/faults/unrelated.json": json.dumps({"faults": [{"kind": "retry", "target": "app POST /emails"}]})}.items():
        (tmp_path / path).parent.mkdir(parents=True, exist_ok=True)
        (tmp_path / path).write_text(text)

    pairs, touched = worker.plan(tmp_path, DIFF)

    assert [(name, Path(faults).name) for name, faults in pairs] == [("checkout", "lost-reply.json")]
    assert touched["scenarios"] == {"checkout": ["src/payments.py is named after payment, which the scenario exercises"]}
