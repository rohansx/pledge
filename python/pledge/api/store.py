"""Where the control plane keeps its objects.

Every object (repo, run, pledge, finding) is one JSON document with an id, a kind and the repo it belongs
to. The logic in `pledge.api.logic` works on these documents through the small interface below, so it is
tested against memory and runs on Postgres unchanged.
"""

from __future__ import annotations

import copy
import json
import threading
from datetime import UTC, datetime
from typing import Protocol

KINDS = ("repo", "run", "pledge", "finding")


def now() -> str:
    return datetime.now(UTC).isoformat()


class Store(Protocol):
    def get(self, kind: str, doc_id: str) -> dict | None: ...
    def put(self, kind: str, doc: dict) -> None: ...
    def list(self, kind: str, repo_id: str | None = None) -> list[dict]:
        """Documents of a kind, newest first, for one repo or for all."""
        ...

    def add_event(self, run_id: str, event_type: str, payload: dict) -> int: ...
    def events_after(self, run_id: str, after: int) -> list[dict]: ...
    def ping(self) -> None: ...


class MemoryStore:
    def __init__(self) -> None:
        self._docs: dict[tuple[str, str], dict] = {}
        self._events: list[dict] = []
        self._lock = threading.Lock()

    def get(self, kind: str, doc_id: str) -> dict | None:
        with self._lock:
            return copy.deepcopy(self._docs.get((kind, doc_id)))

    def put(self, kind: str, doc: dict) -> None:
        with self._lock:
            self._docs[(kind, doc["id"])] = copy.deepcopy(doc)

    def list(self, kind: str, repo_id: str | None = None) -> list[dict]:
        with self._lock:
            docs = [copy.deepcopy(doc) for (k, _), doc in self._docs.items() if k == kind and (repo_id is None or doc.get("repo_id") == repo_id)]
        return sorted(docs, key=lambda doc: doc["created_at"], reverse=True)

    def add_event(self, run_id: str, event_type: str, payload: dict) -> int:
        with self._lock:
            seq = len(self._events) + 1
            self._events.append({"seq": seq, "run_id": run_id, "at": now(), "type": event_type, "payload": copy.deepcopy(payload)})
            return seq

    def events_after(self, run_id: str, after: int) -> list[dict]:
        with self._lock:
            return [copy.deepcopy(event) for event in self._events if event["run_id"] == run_id and event["seq"] > after]

    def ping(self) -> None:
        return None


# ponytail: one document table instead of a table per object. It keeps the store to a few statements, at the
# cost of filtering in Python. Give an object real columns when a list needs a WHERE or a LIMIT the database
# should do, which the run list will need first.
SCHEMA = """
create table if not exists doc (
  kind text not null,
  id text not null,
  repo_id text,
  created_at timestamptz not null,
  data jsonb not null,
  primary key (kind, id)
);
create index if not exists doc_kind_repo on doc (kind, repo_id, created_at desc);
create table if not exists run_event (
  seq bigserial primary key,
  run_id text not null,
  at timestamptz not null default now(),
  type text not null,
  payload jsonb not null
);
create index if not exists run_event_run on run_event (run_id, seq);
"""


def _without_nul(value: object) -> object:
    if isinstance(value, str):
        return value.replace("\x00", "")
    if isinstance(value, dict):
        return {_without_nul(key): _without_nul(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_without_nul(item) for item in value]
    return value


def _jsonb(value: object) -> str:
    """JSON text Postgres jsonb will take. It refuses the NUL character, which text from a sandbox can carry."""
    return json.dumps(_without_nul(value))


class PgStore:
    def __init__(self, database_url: str) -> None:
        from psycopg_pool import ConnectionPool

        self._pool = ConnectionPool(database_url, min_size=1, max_size=5, timeout=5, open=True)

    def migrate(self) -> None:
        with self._pool.connection() as connection:
            connection.execute(SCHEMA)

    def get(self, kind: str, doc_id: str) -> dict | None:
        with self._pool.connection() as connection:
            row = connection.execute("select data from doc where kind = %s and id = %s", (kind, doc_id)).fetchone()
        return row[0] if row else None

    def put(self, kind: str, doc: dict) -> None:
        with self._pool.connection() as connection:
            connection.execute(
                "insert into doc (kind, id, repo_id, created_at, data) values (%s, %s, %s, %s, %s) "
                "on conflict (kind, id) do update set data = excluded.data, repo_id = excluded.repo_id",
                (kind, doc["id"], doc.get("repo_id"), doc["created_at"], _jsonb(doc)),
            )

    def list(self, kind: str, repo_id: str | None = None) -> list[dict]:
        query, params = "select data from doc where kind = %s", [kind]
        if repo_id is not None:
            query, params = query + " and repo_id = %s", [kind, repo_id]
        with self._pool.connection() as connection:
            rows = connection.execute(query + " order by created_at desc limit 1000", params).fetchall()
        return [row[0] for row in rows]

    def add_event(self, run_id: str, event_type: str, payload: dict) -> int:
        with self._pool.connection() as connection:
            row = connection.execute("insert into run_event (run_id, type, payload) values (%s, %s, %s) returning seq", (run_id, event_type, _jsonb(payload))).fetchone()
        return row[0]

    def events_after(self, run_id: str, after: int) -> list[dict]:
        with self._pool.connection() as connection:
            rows = connection.execute("select seq, run_id, at, type, payload from run_event where run_id = %s and seq > %s order by seq limit 500", (run_id, after)).fetchall()
        return [{"seq": seq, "run_id": rid, "at": at.isoformat(), "type": kind, "payload": payload} for seq, rid, at, kind, payload in rows]

    def ping(self) -> None:
        with self._pool.connection() as connection:
            connection.execute("select 1")
