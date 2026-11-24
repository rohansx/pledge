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

