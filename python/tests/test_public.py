"""Write-ups, confirmation and public pages of findings."""

from fastapi.testclient import TestClient

from tests.test_api import AUTH, client, pledge, scan  # noqa: F401 - client is a fixture

STEPS = [
    {"at": 0, "actor": "fault", "text": "POST /payments?reset_token=abc123&email=a@b.c: reply lost", "detail": {"request": '{"card":"4242"}', "reply": '{"token":"secret"}'}},
    {"at": 210, "actor": "check", "text": "Broken: one-charge holds.", "detail": None},
]


def finding_id(client) -> str:
    broken = pledge("one-charge", "broken") | {"recording": {"seed": 1, "journey": "j-1", "faults_hit": 1, "steps": STEPS}}
    scan(client, [broken, pledge("pays", "kept", seeds=("pass",))])
    return client.get("/api/repos/shop/findings").json()["data"][0]["id"]


def patch(client, fid: str, **body):
    return client.patch(f"/api/findings/{fid}", json=body)


def test_a_finding_goes_public_only_once_confirmed_and_explained(client):
    fid = finding_id(client)

    assert patch(client, fid, public=True).json()["error"] == "a person has to confirm the finding against its evidence before it can be public"
    assert patch(client, fid, confirmed=True, public=True).status_code == 409  # still no cause written down; nothing saved
    done = patch(client, fid, confirmed=True, cause="No row lock.", fix="Lock the row.", upstream_repo="acme/shop", public=True).json()["data"]

    assert (done["confirmed"], done["cause"], done["fix"], done["upstreamRepo"]) == (True, "No row lock.", "Lock the row.", "acme/shop")
    assert done["shareToken"] and done["status"] == "open"


def test_the_public_page_needs_no_sign_in_and_leaves_out_request_bodies(client):
    fid = finding_id(client)
    token = patch(client, fid, confirmed=True, cause="No row lock.", public=True).json()["data"]["shareToken"]
    anyone = TestClient(client.app)

    page = anyone.get(f"/api/public/findings/{token}")
    assert page.status_code == 200 and page.headers["cache-control"] == "public, max-age=60"
    data = page.json()["data"]
    assert (data["repo"], data["title"], data["cause"], data["held"]) == ("shop", "one-charge", "No row lock.", {"kept": 1, "checked": 2})
    assert [step["text"] for step in data["timeline"]] == ["POST /payments: reply lost", "Broken: one-charge holds."]
    assert not any(leak in page.text for leak in ("secret", "4242", "abc123", "a@b.c"))
    assert [group["repo"] for group in anyone.get("/api/public/findings").json()["data"]] == ["shop"]
    assert anyone.get("/api/repos", headers={"authorization": ""}).status_code == 401  # the rest stays closed


def test_switching_a_page_off_or_withdrawing_confirmation_kills_its_link_for_good(client):
    fid = finding_id(client)
    first = patch(client, fid, confirmed=True, cause="No row lock.", public=True).json()["data"]["shareToken"]

    assert patch(client, fid, confirmed=False).json()["data"]["shareToken"] is None
    assert client.get(f"/api/public/findings/{first}").status_code == 404
    second = patch(client, fid, confirmed=True, public=True).json()["data"]["shareToken"]
    assert second != first and client.get(f"/api/public/findings/{first}").status_code == 404
    patch(client, fid, public=False)
    assert client.get(f"/api/public/findings/{second}").status_code == 404
    assert client.get("/api/public/findings").json()["data"] == []


def test_an_upstream_issue_link_must_point_at_github_and_can_be_cleared(client):
    fid = finding_id(client)

    assert patch(client, fid, issue_url="https://evil.example/x").status_code == 422
    url = "https://github.com/umami-software/umami/issues/4820"
    assert patch(client, fid, issue_url=url).json()["data"]["issueUrl"] == url
    assert patch(client, fid, issue_url="").json()["data"]["issueUrl"] is None
    assert patch(client, fid, status="fix_proposed").json()["data"]["status"] == "fix_proposed"  # status alone still works


def test_a_newer_run_takes_the_page_offline_until_its_evidence_is_confirmed_and_then_the_same_link_returns(client):
    fid = finding_id(client)
    token = patch(client, fid, confirmed=True, cause="No row lock.", public=True).json()["data"]["shareToken"]

    scan(client, [pledge("one-charge", "broken")])  # new evidence, unchecked

    assert client.get(f"/api/public/findings/{token}").status_code == 404
    assert client.get(f"/api/findings/{fid}").json()["data"]["confirmed"] is False
    # The link stays the same: it may already be quoted in an upstream issue.
    assert patch(client, fid, confirmed=True).json()["data"]["shareToken"] == token
    assert client.get(f"/api/public/findings/{token}").status_code == 200


def test_emptying_the_cause_takes_the_page_down(client):
    fid = finding_id(client)
    token = patch(client, fid, confirmed=True, cause="No row lock.", public=True).json()["data"]["shareToken"]

    assert patch(client, fid, cause="  ").json()["data"]["shareToken"] is None
    assert client.get(f"/api/public/findings/{token}").status_code == 404
