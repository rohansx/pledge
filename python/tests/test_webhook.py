"""The GitHub webhook: the one write path with no bearer token. In-memory store, deliveries signed here."""

import hashlib
import hmac
import json

import pytest
from fake_github import BASE_SHA, SHA
from fastapi.testclient import TestClient

from pledge.api.app import create_app
from pledge.api.store import MemoryStore

SECRET = "webhook-secret"
AUTH = {"authorization": "Bearer test-token"}


@pytest.fixture
def store():
    return MemoryStore()


@pytest.fixture
def client(store):
    return TestClient(create_app(store, "test-token", "abc123", "https://app.example", SECRET))


def deliver(client, event: str, payload: dict | bytes, secret: str = SECRET, signature: str | None = None):
    body = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
    signature = signature if signature is not None else "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    return client.post("/api/github/webhook", content=body, headers={"x-github-event": event, "x-hub-signature-256": signature, "content-type": "application/json"})


def pull_request(action: str = "opened", sha: str = SHA, number: int = 3, head_repo: int | None = 99, **extra) -> dict:
    return {
        "action": action, "number": number, "sender": {"login": "someone"},
        "pull_request": {"number": number, "title": "ignored", "head": {"sha": sha, "ref": "fix", "repo": head_repo and {"id": head_repo}}, "base": {"sha": BASE_SHA, "repo": {"id": 99}}},
        "repository": {"id": 99, "full_name": "o/r", "private": True}, "installation": {"id": 7}, **extra,
    }


def jobs(client, repo: str = "o-r") -> list[dict]:
    return client.get(f"/api/repos/{repo}/jobs", headers=AUTH).json()["data"]


def test_a_delivery_without_a_valid_signature_is_refused_before_its_body_is_read_as_json(client, store):
    for signature in ("", "sha256=" + "0" * 64, "sha1=abc"):
        refused = deliver(client, "pull_request", b"{not json", signature=signature)
        assert (refused.status_code, refused.json()["error"]) == (401, "a valid signature is required")
    assert deliver(client, "pull_request", pull_request(), secret="guessed").status_code == 401
    assert client.post("/api/github/webhook", json=pull_request(), headers={"x-github-event": "pull_request"}).status_code == 401
    assert store.list("job") == [] and store.list("repo") == []


def test_the_bearer_token_is_no_substitute_for_a_signature_and_the_job_list_still_needs_it(client):
    assert client.post("/api/github/webhook", json=pull_request(), headers={**AUTH, "x-github-event": "pull_request"}).status_code == 401
    assert deliver(client, "pull_request", pull_request()).status_code == 202

    assert client.get("/api/repos/o-r/jobs").status_code == 401
    assert client.get("/api/repos/missing/jobs", headers=AUTH).status_code == 404


def test_without_a_webhook_secret_the_endpoint_is_closed_not_open(store):
    closed = TestClient(create_app(store, "test-token"))

    assert deliver(closed, "pull_request", pull_request(), secret="").status_code == 503
    assert store.list("job") == []


def test_a_signed_body_that_is_not_a_delivery_is_422_and_stores_nothing(client, store):
    for payload in (b"{not json", b"[]", json.dumps(pull_request(sha="main")).encode(), json.dumps(pull_request(sha="A" * 40)).encode(),
                    json.dumps({**pull_request(), "repository": {"id": 99, "full_name": "o/r/../x"}}).encode(), json.dumps({**pull_request(), "installation": {"id": "7; drop"}}).encode(),
                    json.dumps(pull_request(number=0)).encode()):
        assert deliver(client, "pull_request", payload).status_code == 422, payload[:60]
    assert store.list("job") == [] and store.list("repo") == []


def test_a_body_over_two_megabytes_is_refused_whether_or_not_it_says_so(client):
    big = b"x" * (2 * 1024 * 1024 + 1)

    assert deliver(client, "pull_request", big).status_code == 413
    chunks = iter([big[: len(big) // 2], big[len(big) // 2 :]])  # streamed: no content-length to trust
    assert client.post("/api/github/webhook", content=chunks, headers={"x-github-event": "pull_request", "x-hub-signature-256": "sha256=0"}).status_code == 413


def test_events_pledge_does_not_use_are_acknowledged_and_ignored(client, store):
    for event, payload in (("ping", {"zen": "Keep it logically awesome."}), ("push", {"ref": "refs/heads/main"}), ("pull_request", pull_request("closed")), ("pull_request", pull_request("labeled"))):
        answer = deliver(client, event, payload)
        assert (answer.status_code, answer.content) == (204, b""), event
    assert store.list("job") == []


def test_an_opened_pull_request_queues_one_job_holding_only_validated_fields(client, store):
    answer = deliver(client, "pull_request", pull_request())

    assert answer.status_code == 202
    assert answer.json()["data"] == jobs(client)[0]
    job = store.list("job")[0]
    assert {key: job[key] for key in ("repo_id", "repo", "installation_id", "pull_request", "head_sha", "base_sha", "status", "fork")} == {
        "repo_id": "o-r", "repo": "o/r", "installation_id": 7, "pull_request": 3, "head_sha": SHA, "base_sha": BASE_SHA, "status": "queued", "fork": False,
    }
    assert "title" not in json.dumps(job) and "someone" not in json.dumps(job)  # nothing else from the payload is kept
    assert store.get("repo", "o-r")["github"] == {"id": 99, "full_name": "o/r", "installation_id": 7}


def test_the_same_head_commit_is_queued_once_however_often_it_is_delivered(client, store):
    first = deliver(client, "pull_request", pull_request("opened")).json()["data"]
    again = deliver(client, "pull_request", pull_request("opened")).json()["data"]
    reopened = deliver(client, "pull_request", pull_request("reopened")).json()["data"]

    assert first["id"] == again["id"] == reopened["id"] and len(store.list("job")) == 1


def test_a_new_push_queues_a_new_job_and_drops_the_one_still_waiting(client):
    deliver(client, "pull_request", pull_request("opened"))
    deliver(client, "pull_request", pull_request("opened", number=4, sha="d" * 40))  # another pull request: untouched
    deliver(client, "pull_request", pull_request("synchronize", sha="c" * 40))

    assert sorted((job["pullRequest"], job["headSha"][0], job["status"], job["reason"]) for job in jobs(client)) == [
        (3, "a", "superseded", "a newer commit was pushed"), (3, "c", "queued", None), (4, "d", "queued", None),
    ]


def test_a_pull_request_from_a_fork_is_marked_as_one(client):
    deliver(client, "pull_request", pull_request(head_repo=1234))
    deliver(client, "pull_request", pull_request(number=4, sha="c" * 40, head_repo=None))  # the fork was deleted

    assert [job["fork"] for job in jobs(client)] == [True, True]


def test_installing_and_removing_the_app_binds_and_unbinds_repos_and_keeps_their_history(client, store):
    installed = deliver(client, "installation", {"action": "created", "installation": {"id": 7}, "repositories": [{"id": 99, "full_name": "o/r"}, {"id": 100, "full_name": "o/other"}]})
    assert (installed.status_code, installed.json()["data"]) == (202, {"bound": 2, "refused": 0, "unbound": 0})
    deliver(client, "pull_request", pull_request())

    removed = deliver(client, "installation_repositories", {"action": "removed", "installation": {"id": 7}, "repositories_removed": [{"id": 99, "full_name": "o/r"}]})

    assert removed.json()["data"] == {"bound": 0, "refused": 0, "unbound": 1}
    assert "github" not in store.get("repo", "o-r") and store.get("repo", "o-other")["github"]["installation_id"] == 7
    assert [(job["status"], job["reason"]) for job in jobs(client)] == [("cancelled", "the GitHub App was removed from this repository")]

    deliver(client, "installation", {"action": "deleted", "installation": {"id": 7}, "repositories": [{"id": 100, "full_name": "o/other"}]})
    assert "github" not in store.get("repo", "o-other")


def test_a_renamed_repository_keeps_its_repo_and_its_jobs(client, store):
    deliver(client, "pull_request", pull_request())
    renamed = {**pull_request(sha="c" * 40), "repository": {"id": 99, "full_name": "o/renamed"}}

    assert deliver(client, "pull_request", renamed).json()["data"]["repoId"] == "o-r"
    assert store.get("repo", "o-r")["github"]["full_name"] == "o/renamed" and store.get("repo", "o-renamed") is None


def test_a_repository_cannot_take_over_another_ones_repo_by_sharing_its_slug(client, store):
    deliver(client, "pull_request", pull_request())  # o/r, GitHub id 99, becomes repo "o-r"

    def from_repo(github_id: int, full_name: str, sha: str):
        return deliver(client, "pull_request", {**pull_request(sha=sha), "repository": {"id": github_id, "full_name": full_name}})

    assert from_repo(555, "o.r/x", "c" * 40).status_code == 202  # first to claim the slug "o-r-x"
    assert from_repo(556, "o-r/x", "d" * 40).status_code == 204  # same slug, another repository: refused
    assert from_repo(777, "o/r", "e" * 40).status_code == 204  # the name o/r registered again under a new GitHub id
    assert store.get("repo", "o-r")["github"]["id"] == 99 and len(store.list("job", "o-r")) == 1
    assert store.get("repo", "o-r-x")["github"]["id"] == 555 and len(store.list("job", "o-r-x")) == 1


def test_a_repo_published_from_the_command_line_is_claimed_only_by_the_repository_it_was_named_after(client, store):
    assert client.post("/api/repos/o/r/runs", json={"trigger": "manual"}, headers=AUTH).json()["data"]["repoId"] == "o-r"
    assert client.post("/api/repos/shop/runs", json={"trigger": "manual"}, headers=AUTH).status_code == 201  # a plain name still works

    stranger = deliver(client, "installation", {"action": "created", "installation": {"id": 8}, "repositories": [{"id": 5, "full_name": "o./r"}]})  # slugs to "o-r" too
    assert stranger.json()["data"] == {"bound": 0, "refused": 1, "unbound": 0}
    assert deliver(client, "pull_request", {**pull_request(), "repository": {"id": 5, "full_name": "o./r"}, "installation": {"id": 8}}).status_code == 204
    assert "github" not in store.get("repo", "o-r") and store.list("job") == []

    assert deliver(client, "pull_request", pull_request()).status_code == 202  # o/r itself
    assert store.get("repo", "o-r")["github"]["id"] == 99 and len(store.list("run", "o-r")) == 1  # same repo, its run kept


def test_authoring_leaves_its_snapshot_on_the_repo_for_pull_request_scans(client, store):
    run = client.post("/api/repos/o%2Fr/runs", json={"trigger": "first_scan"}, headers=AUTH).json()["data"]
    record = {
        "schema_version": 1, "scenario": "checkout", "faults": None, "env": {}, "pledges": [], "sandbox": None,
        "runs": [{"seed": 1, "run_id": "r1", "verdict": "pass", "faults_injected": 0, "journeys": 20, "limitations": []}],
        "authoring": {"seconds": 900.0, "phases": [], "summary": "Wrote one scenario.", "open_questions": [], "snapshot_id": "fp1ux9ivto1742yp1opg:default"},
    }

    assert client.post(f"/api/runs/{run['id']}/result", json=record, headers=AUTH).status_code == 201
    assert store.get("repo", "o-r")["snapshot_id"] == "fp1ux9ivto1742yp1opg:default"

    bad = client.post("/api/repos/o%2Fr/runs", json={"trigger": "manual"}, headers=AUTH).json()["data"]
    record["authoring"]["snapshot_id"] = "x; rm -rf /"
    assert client.post(f"/api/runs/{bad['id']}/result", json=record, headers=AUTH).status_code == 422
