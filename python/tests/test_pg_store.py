"""The Postgres store against a real database. Skipped unless TEST_DATABASE_URL points at a disposable one;
CI provides it. Everything else is tested through MemoryStore, so this only has to show the two agree."""

import os
import uuid

import pytest

from pledge.api.store import MemoryStore, now

URL = os.environ.get("TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(not URL, reason="TEST_DATABASE_URL is not set")


@pytest.fixture
def stores():
    from pledge.api.store import PgStore

    pg = PgStore(URL)
    pg.migrate()
    pg.migrate()  # idempotent: it runs at every start
    return pg, MemoryStore()


def test_postgres_and_memory_agree_on_documents_and_events(stores):
    repo = f"repo-{uuid.uuid4().hex[:8]}"
    first = {"id": str(uuid.uuid4()), "repo_id": repo, "created_at": now(), "phase": "run", "nested": {"seeds": [1, 2], "text": "naïve ✓"}}
    second = {"id": str(uuid.uuid4()), "repo_id": repo, "created_at": now(), "phase": "done"}
    for store in stores:
        store.ping()
        store.put("run", first)
        store.put("run", second)
        store.put("run", {**first, "phase": "done"})  # an update replaces the document
        store.put("pledge", {"id": f"{repo}~s~p", "repo_id": repo, "created_at": now()})

        assert store.get("run", first["id"]) == {**first, "phase": "done"}
        assert store.get("run", "missing") is None
        assert [doc["id"] for doc in store.list("run", repo)] == [second["id"], first["id"]]  # newest first
        assert [doc["id"] for doc in store.list("pledge", repo)] == [f"{repo}~s~p"]
        assert store.list("finding", repo) == []

        seqs = [store.add_event(first["id"], "phase_step", {"label": f"step {n}"}) for n in range(3)]
        assert seqs == sorted(seqs) and len(set(seqs)) == 3
        after = store.events_after(first["id"], seqs[0])
        assert [(event["type"], event["payload"]["label"]) for event in after] == [("phase_step", "step 1"), ("phase_step", "step 2")]
        assert store.events_after(second["id"], 0) == []


def test_text_with_a_nul_character_is_stored_without_it(stores):
    """Postgres jsonb refuses \\u0000; a reply body from a sandbox once carried one and the API answered 500."""
    doc = {"id": str(uuid.uuid4()), "repo_id": "r", "created_at": now(), "reply": "a\x00b", "steps": [{"t\x00": "c\x00"}]}
    for store in stores:
        store.put("run", doc)
        store.add_event(doc["id"], "phase_step", {"label": "x\x00y"})
    pg, _ = stores
    assert pg.get("run", doc["id"])["reply"] == "ab" and pg.get("run", doc["id"])["steps"] == [{"t": "c"}]



def test_postgres_and_memory_hand_a_job_to_one_claimer_oldest_first_and_a_stale_one_once_more(stores):
    from concurrent.futures import ThreadPoolExecutor

    pg, _ = stores
    for job in pg.list("job"):  # the claim is over every repo's jobs, so leftovers of an earlier test run would be claimed
        pg.put("job", {**job, "status": "done"})
    repo = f"repo-{uuid.uuid4().hex[:8]}"
    for store in stores:
        ids = []
        for n in range(6):
            ids.append(f"{repo}~{n}~{uuid.uuid4().hex}")
            store.put("job", {"id": ids[-1], "repo_id": repo, "created_at": f"2026-01-01T00:00:0{n}+00:00", "status": "queued", "attempts": 0, "claimed_at": None, "pull_request": n})
        with ThreadPoolExecutor(max_workers=4) as pool:  # two real connections racing is the point on Postgres
            claimed = list(pool.map(lambda _: store.claim_job("2026-01-01T01:00:00+00:00", "2026-01-01T00:00:00+00:00"), range(8)))
        got = [job for job in claimed if job]
        assert sorted(job["id"] for job in got) == sorted(ids) and claimed.count(None) == 2
        assert all((job["status"], job["attempts"], job["claimed_at"], job["repo_id"]) == ("running", 1, "2026-01-01T01:00:00+00:00", repo) for job in got)
        assert store.get("job", ids[0])["status"] == "running"

        # An hour on, every one of them is stale: each is handed out once more, oldest first, and never a third time.
        again = [store.claim_job("2026-01-01T03:00:00+00:00", "2026-01-01T02:00:00+00:00") for _ in range(7)]
        assert [job and job["id"] for job in again] == [*ids, None] and all(job["attempts"] == 2 for job in again[:6])
        assert store.claim_job("2026-01-01T05:00:00+00:00", "2026-01-01T04:00:00+00:00") is None


def test_a_blob_comes_back_byte_for_byte_and_is_replaced_by_key(stores):
    key = f"run/{uuid.uuid4()}/trace.zip"
    for store in stores:
        assert store.get_blob(key) is None
        store.put_blob(key, "application/zip", b"\x00\x01first")
        store.put_blob(key, "application/zip", b"\x00\xffsecond")
        assert store.get_blob(key) == ("application/zip", b"\x00\xffsecond")
