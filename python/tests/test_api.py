"""The control-plane API against the in-memory store: no database, no network."""

import pytest
from fastapi.testclient import TestClient

from pledge.api.app import create_app
from pledge.api.store import MemoryStore

TOKEN = "test-token"
AUTH = {"authorization": f"Bearer {TOKEN}"}


@pytest.fixture
def client():
    return TestClient(create_app(MemoryStore(), TOKEN, "abc123", "https://app.example"), headers=AUTH)


def pledge(key, result, status="proposed", seeds=("fail",)):
    marks = [{"seed": n + 1, "run_id": f"r{n + 1}", "status": mark, **({"expected": {"/charged_twice": 0}, "actual": {"/charged_twice": 13}} if mark == "fail" else {})} for n, mark in enumerate(seeds)]
    return {
        "id": key, "statement": f"{key} holds.", "status": status, "source": "domain_template", "confidence": "high", "assertion": key.replace("-", "_"),
        "result": result, "kept": sum(m == "pass" for m in seeds), "broken": sum(m == "fail" for m in seeds), "unknown": 0, "seeds": marks,
    }


def result(pledges, faults="lost-reply", seeds=1):
    return {
        "schema_version": 1, "scenario": "checkout", "env": {}, "sandbox": {"template": "pledge-base", "outbound_blocked": True, "seconds": {"total": 29.4}}, "authoring": None,
        "faults": {"name": faults, "description": "Replies are lost.", "faults": [{"kind": "retry", "target": "app POST /payments", "params": {"rate": 0.5}}]} if faults else None,
        "pledges": pledges,
        "runs": [{"seed": n + 1, "run_id": f"r{n + 1}", "verdict": "fail", "faults_injected": 10, "journeys": 20, "requests": 60, "unexpected_failures": 0, "limitations": []} for n in range(seeds)],
    }


def scan(client, pledges, repo="shop", **kwargs):
    run = client.post(f"/api/repos/{repo}/runs", json={"trigger": "manual"}).json()["data"]
    done = client.post(f"/api/runs/{run['id']}/result", json=result(pledges, **kwargs))
    assert done.status_code == 201, done.json()
    return done.json()["data"]


def test_healthz_is_public_and_everything_else_needs_the_token(client):
    assert client.get("/api/healthz", headers={"authorization": ""}).json() == {"success": True, "data": {"version": "abc123", "db": "ok"}, "error": None}
    for headers in ({"authorization": ""}, {"authorization": "Bearer nope"}, {"authorization": "Bearer test-toke"}):
        response = client.get("/api/repos", headers=headers)
        assert (response.status_code, response.json()["error"]) == (401, "a valid token is required")


def test_routes_are_closed_not_open_when_no_token_is_configured():
    closed = TestClient(create_app(MemoryStore(), None))

    assert closed.get("/api/repos", headers=AUTH).status_code == 503
    assert closed.get("/api/healthz").status_code == 200


def test_unknown_paths_and_unknown_objects_are_404_in_the_envelope(client):
    for path in ("/api/nope", "/api/runs/missing", "/api/findings/missing", "/api/pledges/missing", "/api/repos/missing/overview"):
        response = client.get(path)
        assert (response.status_code, response.json()) == (404, {"success": False, "data": None, "error": "not found"}), path


def test_a_finished_run_creates_the_repo_its_pledges_and_a_finding(client):
    run = scan(client, [pledge("one-charge", "broken"), pledge("pays", "kept", seeds=("pass",))])

    assert run["phase"] == "done" and run["verdict"] == "inconclusive"  # nothing is approved, so nothing blocks
    assert run["summary"] == {"requestsSent": 60, "requestsSucceeded": 60, "pledgesChecked": 2, "pledgesBroken": 1, "seeds": 1, "faultsInjected": 10}
    assert [row["id"] for row in client.get("/api/repos").json()["data"]] == ["shop"]
    pledges = client.get("/api/repos/shop/pledges").json()["data"]
    assert [(p["key"], p["status"], p["source"], p["lastVerdict"]) for p in pledges] == [("one-charge", "proposed", "template", "broken"), ("pays", "proposed", "template", "kept")]
    findings = client.get("/api/repos/shop/findings").json()["data"]
    assert [(f["statement"], f["status"], f["brokenSeeds"], f["totalSeeds"]) for f in findings] == [("one-charge holds.", "open", [1], 1)]
    assert run["findingIds"] == [findings[0]["id"]]


def test_finding_detail_carries_expected_actual_and_a_replay_command(client):
    scan(client, [pledge("one-charge", "broken", seeds=("pass", "fail"))], seeds=2)
    finding_id = client.get("/api/repos/shop/findings").json()["data"][0]["id"]

    detail = client.get(f"/api/findings/{finding_id}").json()["data"]

    assert detail["expected"] == {"/charged_twice": 0} and detail["actual"] == {"/charged_twice": 13}
    assert detail["brokenSeeds"] == [2]
    assert detail["replayCommand"] == "pledge run . --scenario checkout --faults .pledge/faults/lost-reply.json --seed 2"
    assert detail["summary"]["requestsSent"] == 120
    assert detail["timeline"] == [] and detail["recording"] is None  # no recording sent; never invented
    assert detail["minimalFaultPlan"] == []
    assert detail["blocks"] is False


def test_the_findings_list_carries_the_damage_and_puts_money_first(client):
    scan(client, [pledge("item-update-persists", "broken"), pledge("comment-created-once", "broken"), pledge("psp-never-charged-twice", "broken")])

    findings = client.get("/api/repos/shop/findings").json()["data"]

    assert [(f["pledgeKey"], f["severity"]) for f in findings] == [("psp-never-charged-twice", "money"), ("comment-created-once", "duplicate"), ("item-update-persists", "data")]
    assert findings[0]["expected"] == {"/charged_twice": 0} and findings[0]["actual"] == {"/charged_twice": 13}


def test_findings_real_callers_can_cause_come_before_those_only_a_direct_api_caller_could(client):
    probe = pledge("psp-never-charged-twice", "broken") | {"reach": "api_only", "trigger": "No shipped client repeats this; only a direct API caller could."}
    clicked = pledge("item-update-persists", "broken") | {"reach": "ui", "trigger": "The user double-clicks Save: the button is not disabled while saving."}
    scan(client, [probe, pledge("comment-created-once", "broken"), clicked])

    findings = client.get("/api/repos/shop/findings").json()["data"]

    # Reach outranks severity: money that no shipped client can lose is below a wrong record a click can make.
    assert [(f["pledgeKey"], f["reach"]) for f in findings] == [("item-update-persists", "ui"), ("comment-created-once", "unknown"), ("psp-never-charged-twice", "api_only")]
    detail = client.get(f"/api/findings/{findings[0]['id']}").json()["data"]
    assert (detail["reach"], detail["trigger"]) == ("ui", "The user double-clicks Save: the button is not disabled while saving.")
    pledges = {p["key"]: p for p in client.get("/api/repos/shop/pledges").json()["data"]}
    assert (pledges["psp-never-charged-twice"]["reach"], pledges["psp-never-charged-twice"]["trigger"]) == ("api_only", probe["trigger"])
    assert (pledges["comment-created-once"]["reach"], pledges["comment-created-once"]["trigger"]) == ("unknown", "")  # sent by an older command line
    assert client.get(f"/api/pledges/{pledges['item-update-persists']['id']}").json()["data"]["reach"] == "ui"


def test_a_reach_outside_the_known_ones_is_refused(client):
    run = client.post("/api/repos/shop/runs", json={"trigger": "manual"}).json()["data"]
    assert client.post(f"/api/runs/{run['id']}/result", json=result([pledge("one-charge", "broken") | {"reach": "everyone"}])).status_code == 422


def test_a_recording_becomes_the_finding_timeline_and_its_seed_the_replay(client):
    broken = pledge("one-charge", "broken", seeds=("fail", "fail"))
    steps = [
        {"at": 0, "actor": "fault", "text": "POST /payments: reply lost", "detail": {"request": '{"amount":5}', "reply": '{"id":1}'}},
        {"at": 210, "actor": "client", "text": "POST /payments → 201", "detail": {"request": '{"amount":5}', "reply": '{"id":2}'}},
        {"at": 210, "actor": "check", "text": "Broken: one-charge holds.", "detail": None},
    ]
    broken["recording"] = {"seed": 2, "journey": "run-traffic-3", "faults_hit": 1, "steps": steps}
    scan(client, [broken], seeds=2)
    finding_id = client.get("/api/repos/shop/findings").json()["data"][0]["id"]

    detail = client.get(f"/api/findings/{finding_id}").json()["data"]

    assert detail["timeline"] == steps
    assert detail["recording"] == {"seed": 2, "journey": "run-traffic-3", "faults_hit": 1}
    assert detail["replayCommand"].endswith("--seed 2")


def test_a_recording_step_with_an_unknown_actor_is_refused(client):
    broken = pledge("one-charge", "broken")
    broken["recording"] = {"seed": 1, "journey": "j", "faults_hit": 0, "steps": [{"at": 0, "actor": "root", "text": "x", "detail": None}]}
    run = client.post("/api/repos/shop/runs", json={"trigger": "manual"}).json()["data"]
    assert client.post(f"/api/runs/{run['id']}/result", json=result([broken])).status_code == 422


def test_only_an_approved_pledge_makes_a_run_broken(client):
    scan(client, [pledge("one-charge", "broken")])
    pledge_id = client.get("/api/repos/shop/pledges").json()["data"][0]["id"]

    refused = client.patch(f"/api/pledges/{pledge_id}", json={"action": "approve"})
    assert refused.status_code == 409 and "needs an explicit override" in refused.json()["error"]

    approved = client.patch(f"/api/pledges/{pledge_id}", json={"action": "approve", "override": True, "note": "reviewed by hand"}).json()["data"]
    assert approved["status"] == "approved"
    assert approved["decision"]["override"] is True and approved["decision"]["note"] == "reviewed by hand"

    # The same stored run now reads as broken, and a new one is broken too.
    assert client.get("/api/repos/shop/runs").json()["data"][0]["verdict"] == "broken"
    assert scan(client, [pledge("one-charge", "broken")])["verdict"] == "broken"
    assert scan(client, [pledge("one-charge", "kept", seeds=("pass",))])["verdict"] == "kept"


def test_a_decision_in_the_dashboard_outlives_the_status_in_the_repo_file(client):
    scan(client, [pledge("one-charge", "kept", seeds=("pass",))])
    pledge_id = client.get("/api/repos/shop/pledges").json()["data"][0]["id"]
    client.patch(f"/api/pledges/{pledge_id}", json={"action": "retire"})

    scan(client, [pledge("one-charge", "kept", status="proposed", seeds=("pass",))])

    assert client.get(f"/api/pledges/{pledge_id}").json()["data"]["status"] == "retired"
    assert client.patch(f"/api/pledges/{pledge_id}", json={"action": "approve", "override": True}).status_code == 409


def test_a_finding_is_verified_only_by_a_later_run_that_keeps_the_pledge(client):
    scan(client, [pledge("one-charge", "broken")])
    finding_id = client.get("/api/repos/shop/findings").json()["data"][0]["id"]
    status = lambda: client.get(f"/api/findings/{finding_id}").json()["data"]["status"]  # noqa: E731

    assert client.patch(f"/api/findings/{finding_id}", json={"status": "verified"}).status_code == 422  # not a status a person can set
    assert client.patch(f"/api/findings/{finding_id}", json={"status": "fixed_unverified"}).json()["data"]["status"] == "fixed_unverified"

    scan(client, [pledge("one-charge", "kept", seeds=("pass",))], faults=None)
    assert status() == "fixed_unverified"  # a baseline did not inject the fault that broke it, so it proves nothing

    scan(client, [pledge("one-charge", "kept", seeds=("pass",))])
    assert status() == "verified"
    assert client.patch(f"/api/findings/{finding_id}", json={"status": "open"}).status_code == 409

    scan(client, [pledge("one-charge", "broken")])
    assert status() == "reopened"
    assert len(client.get("/api/repos/shop/findings").json()["data"]) == 1  # the same finding, not a second one


def test_a_pledges_standing_comes_from_the_run_under_faults_not_a_newer_baseline(client):
    scan(client, [pledge("one-charge", "broken")])
    scan(client, [pledge("one-charge", "kept", seeds=("pass",))], faults=None)

    row = client.get("/api/repos/shop/pledges").json()["data"][0]

    assert (row["lastVerdict"], row["lastFaults"]) == ("broken", "lost-reply")
    detail = client.get(f"/api/pledges/{row['id']}").json()["data"]
    assert [(point["faults"], point["result"]) for point in detail["history"]] == [(None, "kept"), ("lost-reply", "broken")]


def test_overview_answers_whether_it_is_safe_to_ship_in_one_call(client):
    scan(client, [pledge("one-charge", "broken"), pledge("pays", "kept", seeds=("pass",))])

    overview = client.get("/api/repos/shop/overview").json()["data"]

    assert (overview["headline"]["kept"], overview["headline"]["total"], overview["headline"]["blocking"]) == (1, 2, 0)
    assert [row["key"] for row in overview["headline"]["broken"]] == ["one-charge"]
    assert overview["counters"] == {"bugsCaught": 1, "pullRequestsChecked": 0, "faultsInjected": 10, "approvedPledges": 0, "seedsRun": 1, "awaitingReview": 2, "openFindings": 1}
    assert overview["latestRun"]["summary"]["pledgesBroken"] == 1 and overview["runningRunId"] is None
    assert len(overview["trend"]) == 1 and overview["trend"][0]["kept"] == 1 and overview["trend"][0]["broken"] == 1
    assert len(overview["latestRuns"]) == 1 and len(overview["latestFindings"]) == 1


def test_a_run_in_progress_shows_as_running_and_streams_its_events(client):
    run = client.post("/api/repos/shop/runs", json={"trigger": "first_scan", "phase": "boot"}).json()["data"]
    assert client.get("/api/repos/shop/overview").json()["data"]["runningRunId"] == run["id"]

    client.post(f"/api/runs/{run['id']}/events", json={"type": "phase_step", "payload": {"phase": "boot", "label": "install", "ok": True}})
    client.post(f"/api/runs/{run['id']}/events", json={"type": "phase_started", "payload": {"phase": "author"}})
    assert client.get(f"/api/runs/{run['id']}").json()["data"]["phase"] == "author"
    client.post(f"/api/runs/{run['id']}/result", json=result([pledge("one-charge", "broken")]))

    stream = client.get(f"/api/runs/{run['id']}/events").text
    kinds = [line.removeprefix("event: ") for line in stream.splitlines() if line.startswith("event: ")]
    assert kinds == ["phase_started", "phase_step", "phase_started", "run_finished"]
    assert '"label": "install"' in stream and '"verdict": "inconclusive"' in stream

    later = client.get(f"/api/runs/{run['id']}/events", params={"after": 3}).text
    assert [line for line in later.splitlines() if line.startswith("event: ")] == ["event: run_finished"]


def test_a_run_that_gives_up_is_failed_and_takes_no_more_events(client):
    run = client.post("/api/repos/shop/runs", json={}).json()["data"]

    client.post(f"/api/runs/{run['id']}/events", json={"type": "run_finished", "payload": {"failed": "boot: budget exhausted"}})

    stored = client.get(f"/api/runs/{run['id']}").json()["data"]
    assert (stored["phase"], stored["failure"], stored["verdict"]) == ("failed", "boot: budget exhausted", None)
    assert client.post(f"/api/runs/{run['id']}/events", json={"type": "phase_step", "payload": {}}).status_code == 409
    assert client.post(f"/api/runs/{run['id']}/result", json=result([pledge("p", "kept", seeds=("pass",))])).status_code == 409


def test_the_pull_request_comment_separates_what_blocks_from_what_is_for_review(client):
    scan(client, [pledge("one-charge", "kept", seeds=("pass",)), pledge("stock", "kept", seeds=("pass",))])
    first = client.get("/api/repos/shop/pledges").json()["data"][0]["id"]
    client.patch(f"/api/pledges/{first}", json={"action": "approve", "override": True})
    run = scan(client, [pledge("one-charge", "broken"), pledge("stock", "broken"), pledge("pays", "kept", seeds=("pass",))])

    markdown = client.get(f"/api/runs/{run['id']}/comment").json()["data"]["markdown"]

    finding = next(f["id"] for f in client.get("/api/repos/shop/findings").json()["data"] if f["pledgeKey"] == "one-charge")
    assert markdown.splitlines()[0] == "**Pledge: 1 of 3 pledges broken**"
    assert "60 requests sent · 100% returned success · 2 pledges broken" in markdown
    assert f"- one-charge holds. Broke on 1 of 1 seeds. [View finding](https://app.example/r/shop/findings/{finding})" in markdown
    assert markdown.index("**Broken**") < markdown.index("one-charge holds.") < markdown.index("**For review**") < markdown.index("stock holds.")
    assert markdown.splitlines()[-1] == "Kept: 1. Skipped (not touched by this change): 0."


@pytest.mark.parametrize(
    ("change", "where"),
    [({"scenario": "has spaces"}, "scenario"), ({"extra": 1}, "extra"), ({"runs": []}, "runs"), ({"pledges": [dict(pledge("p", "kept"), statement="x" * 1001)]}, "pledges.0.statement"), ({"pledges": [dict(pledge("p", "kept"), id="../etc")]}, "pledges.0.id")],
)
def test_a_malformed_result_is_refused_and_leaves_the_run_unfinished(client, change, where):
    run = client.post("/api/repos/shop/runs", json={}).json()["data"]

    response = client.post(f"/api/runs/{run['id']}/result", json=result([pledge("p", "kept", seeds=("pass",))]) | change)

    assert response.status_code == 422 and response.json()["error"].startswith(f"invalid request: {where}:")
    assert client.get(f"/api/runs/{run['id']}").json()["data"]["phase"] == "run"
    assert client.get("/api/repos/shop/pledges").json()["data"] == []


def test_an_oversized_body_is_refused(client):
    response = client.post("/api/repos/shop/runs", content=b"x" * (2 * 1024 * 1024 + 1), headers={"content-type": "application/json"})

    assert response.status_code == 413


def test_what_is_not_built_says_so_instead_of_pretending(client):
    scan(client, [pledge("one-charge", "broken")])
    finding_id = client.get("/api/repos/shop/findings").json()["data"][0]["id"]

    assert client.get("/api/repos/shop/coverage").json()["data"]["available"] is False
    assert client.post(f"/api/findings/{finding_id}/rerun").status_code == 501


def test_jsonb_text_never_carries_a_nul():
    from pledge.api.store import _jsonb

    assert _jsonb({"a\x00": ["b\x00", 1, None, {"c": "d\x00e"}]}) == '{"a": ["b", 1, null, {"c": "de"}]}'


def test_a_runs_browser_recording_is_stored_served_and_shown_on_its_finding(client):
    run = scan(client, [pledge("one-lead", "broken")])
    finding = client.get(f"/api/findings/{run['findingIds'][0]}").json()["data"]
    assert finding["browser"] is None

    media = f"/api/runs/{run['id']}/media"
    for name, body in (("trace.zip", b"PK\x03\x04trace"), ("screenshot.png", b"\x89PNG")):
        assert client.put(f"{media}/{name}?seed=2&journey=j-3", content=body).status_code == 201
    assert client.get(f"/api/findings/{finding['id']}").json()["data"]["browser"] == {"seed": 2, "journey": "j-3", "files": ["screenshot.png", "trace.zip"], "runId": run["id"]}
    served = client.get(f"{media}/trace.zip")
    assert (served.content, served.headers["content-type"]) == (b"PK\x03\x04trace", "application/zip")

    assert client.get(f"{media}/trace.zip", headers={"authorization": ""}).status_code == 401
    assert client.get(f"{media}/video.webm").status_code == 404  # an allowed name, never stored
    assert client.put(f"{media}/evil.html?seed=1&journey=j", content=b"<script>").status_code == 404
    assert client.put(f"/api/runs/missing/media/trace.zip?seed=1&journey=j", content=b"x").status_code == 404
    assert client.put(f"{media}/trace.zip?seed=1&journey=j", content=b"").status_code == 422
