"""The control-plane API. The dashboard and the command line are both clients of it.

    uvicorn pledge.api.app:app          # needs DATABASE_URL and PLEDGE_API_TOKEN

Every response is {"success", "data", "error"}. Every route but /api/healthz needs a signed-in user.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import os
from collections.abc import AsyncIterator, Callable

import anyio
from fastapi import APIRouter, Depends, FastAPI, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, StreamingResponse

from pledge.api import logic
from pledge.api.models import EventIn, FindingPatch, PledgePatch, RunResultIn, RunStartIn
from pledge.api.store import Store

log = logging.getLogger("pledge.api")
MAX_BODY_BYTES = 2 * 1024 * 1024
STREAM_POLL_SECONDS = 1.0
STREAM_MAX_SECONDS = 60 * 60


def ok(data: object, status: int = 200) -> JSONResponse:
    return JSONResponse({"success": True, "data": data, "error": None}, status_code=status, headers={"cache-control": "no-store"})


def fail(status: int, message: str) -> JSONResponse:
    return JSONResponse({"success": False, "data": None, "error": message}, status_code=status, headers={"cache-control": "no-store"})


def token_auth(token: str | None) -> Callable[[Request], dict]:
    """Sign-in by one shared bearer token. It returns the same user shape GitHub sign-in will, so that
    swapping the two means replacing this function and nothing that depends on it."""

    def current_user(request: Request) -> dict:
        if not token:
            raise HTTPException(503, "sign-in is not configured")
        header = request.headers.get("authorization", "")
        presented = header.removeprefix("Bearer ") if header.startswith("Bearer ") else ""
        digest = lambda value: hashlib.sha256(value.encode()).digest()  # noqa: E731 - equal lengths for compare_digest
        if not presented or not hmac.compare_digest(digest(presented), digest(token)):
            raise HTTPException(401, "a valid token is required")
        return {"name": "Access token", "kind": "token"}

    return current_user


def create_app(store: Store, token: str | None, version: str = "dev", public_url: str = "") -> FastAPI:
    app = FastAPI(title="Pledge", docs_url=None, redoc_url=None, openapi_url=None)
    auth = token_auth(token)
    api = APIRouter(prefix="/api", dependencies=[Depends(auth)])

    @app.exception_handler(HTTPException)
    async def http_error(_: Request, error: HTTPException) -> JSONResponse:
        return fail(error.status_code, str(error.detail))

    @app.exception_handler(RequestValidationError)
    async def invalid(_: Request, error: RequestValidationError) -> JSONResponse:
        first = error.errors()[0]
        where = ".".join(str(part) for part in first["loc"] if part != "body") or "body"
        return fail(422, f"invalid request: {where}: {first['msg']}")

    @app.exception_handler(logic.NotFound)
    async def not_found(_: Request, error: logic.NotFound) -> JSONResponse:
        return fail(404, "not found")

    @app.exception_handler(logic.Refused)
    async def refused(_: Request, error: logic.Refused) -> JSONResponse:
        return fail(409, str(error))

    @app.exception_handler(Exception)
    async def crashed(request: Request, error: Exception) -> JSONResponse:
        log.exception("%s %s failed", request.method, request.url.path)  # detail stays in the server log
        return fail(500, "internal error")

    @app.middleware("http")
    async def limit_body(request: Request, call_next):
        length = request.headers.get("content-length")
        if length and length.isdigit() and int(length) > MAX_BODY_BYTES:
            return fail(413, "body too large")
        return await call_next(request)

    @app.get("/api/healthz")
    def healthz() -> JSONResponse:
        try:
            store.ping()
        except Exception:  # noqa: BLE001 - whatever is wrong with the database, the answer is the same
            log.exception("healthz: database check failed")
            return fail(503, "database unreachable")
        return ok({"version": version, "db": "ok"})

    @api.get("/me")
    def me(user: dict = Depends(auth)) -> JSONResponse:
        return ok({"user": user, "repos": [{"id": repo["id"], "name": repo["name"]} for repo in logic.repo_list(store)]})

    @api.get("/repos")
    def repos() -> JSONResponse:
        return ok(logic.repo_list(store))

    @api.get("/repos/{repo_id}/overview")
    def repo_overview(repo_id: str) -> JSONResponse:
        return ok(logic.overview(store, repo_id))

    @api.get("/repos/{repo_id}/findings")
    def findings(repo_id: str, status: str | None = Query(default=None, max_length=30)) -> JSONResponse:
        return ok(logic.finding_list(store, repo_id, status))

    @api.get("/findings/{finding_id}")
    def finding(finding_id: str) -> JSONResponse:
        return ok(logic.finding_view(store, logic._need(store, "finding", finding_id)))

    @api.patch("/findings/{finding_id}")
    def change_finding(finding_id: str, patch: FindingPatch) -> JSONResponse:
        return ok(logic.patch_finding(store, finding_id, patch))

    @api.post("/findings/{finding_id}/rerun")
    def rerun_finding(finding_id: str) -> JSONResponse:
        logic._need(store, "finding", finding_id)
        return fail(501, "reruns are started from the command line until the orchestrator exists; run the replay command")

    @api.get("/repos/{repo_id}/pledges")
    def pledges(repo_id: str, status: str | None = Query(default=None, max_length=30)) -> JSONResponse:
        return ok(logic.pledge_list(store, repo_id, status))

    @api.get("/pledges/{pledge_id}")
    def pledge(pledge_id: str) -> JSONResponse:
        return ok(logic.pledge_view(store, logic._need(store, "pledge", pledge_id)))

    @api.patch("/pledges/{pledge_id}")
    def decide_pledge(pledge_id: str, patch: PledgePatch) -> JSONResponse:
        return ok(logic.patch_pledge(store, pledge_id, patch))

    @api.get("/repos/{repo_id}/coverage")
    def coverage(repo_id: str) -> JSONResponse:
        logic._need(store, "repo", repo_id)
        # Nothing yet maps a scenario's requests onto the repo's routes, so there is no grid to return.
        return ok({"available": False, "routes": [], "pledges": [], "gaps": []})

    @api.get("/repos/{repo_id}/runs")
    def runs(repo_id: str) -> JSONResponse:
        logic._need(store, "repo", repo_id)
        catalogue = logic._pledges(store, repo_id)
        return ok([logic.run_row(run, catalogue) for run in store.list("run", repo_id)])

    @api.post("/repos/{repo_name}/runs")
    def start_run(repo_name: str, start: RunStartIn) -> JSONResponse:
        """Registers a run the command line is making. Starting one from here needs the orchestrator."""
        return ok(logic.run_row(logic.start_run(store, repo_name, start), {}), 201)

    @api.get("/runs/{run_id}")
    def run(run_id: str) -> JSONResponse:
        return ok(logic.run_view(store, logic._need(store, "run", run_id)))

    @api.post("/runs/{run_id}/events")
    def add_event(run_id: str, event: EventIn) -> JSONResponse:
        return ok({"seq": logic.record_event(store, run_id, event)}, 201)

    @api.post("/runs/{run_id}/result")
    def finish(run_id: str, result: RunResultIn) -> JSONResponse:
        return ok(logic.finish_run(store, run_id, result), 201)

    @api.get("/runs/{run_id}/comment")
    def comment(run_id: str) -> JSONResponse:
        return ok({"markdown": logic.pr_comment(store, logic._need(store, "run", run_id), public_url)})

    @api.get("/runs/{run_id}/events")
    async def events(run_id: str, after: int = Query(default=0, ge=0)) -> StreamingResponse:
        """Server-Sent Events: everything after `after`, then each new event as it is recorded, until the
        run finishes."""
        if await anyio.to_thread.run_sync(store.get, "run", run_id) is None:
            raise logic.NotFound(run_id)

        async def stream() -> AsyncIterator[str]:
            cursor, waited = after, 0.0
            while waited < STREAM_MAX_SECONDS:
                batch = await anyio.to_thread.run_sync(store.events_after, run_id, cursor)
                for event in batch:
                    cursor = event["seq"]
                    yield f"id: {event['seq']}\nevent: {event['type']}\ndata: {json.dumps({'at': event['at'], **event['payload']})}\n\n"
                    if event["type"] == "run_finished":
                        return
                if not batch:
                    current = await anyio.to_thread.run_sync(store.get, "run", run_id)
                    if current is None or current["phase"] in ("done", "failed"):
                        return  # finished before this client connected, and it has everything
                    yield ": waiting\n\n"  # keeps proxies from closing an idle stream
                # ponytail: polls the store once a second. Use Postgres LISTEN/NOTIFY when a second feels slow.
                await asyncio.sleep(STREAM_POLL_SECONDS)
                waited += STREAM_POLL_SECONDS

        return StreamingResponse(stream(), media_type="text/event-stream", headers={"cache-control": "no-store", "x-accel-buffering": "no"})

    app.include_router(api)

    @app.api_route("/api/{rest:path}", methods=["GET", "POST", "PATCH", "PUT", "DELETE"])
    def unknown(rest: str) -> JSONResponse:
        return fail(404, "not found")

    return app


def _from_environment() -> FastAPI:
    from pledge.api.store import PgStore

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        raise SystemExit("DATABASE_URL is required")
    token = os.environ.get("PLEDGE_API_TOKEN") or None
    if not token:
        log.warning("PLEDGE_API_TOKEN is not set: every route but /api/healthz will answer 503")
    store = PgStore(database_url)
    try:
        store.migrate()
    except Exception:  # noqa: BLE001 - keep serving so the health check reports it instead of the container flapping
        log.exception("schema setup failed")
    return create_app(store, token, os.environ.get("PLEDGE_VERSION", "dev"), os.environ.get("PLEDGE_PUBLIC_URL", "https://app.pledge.sh"))


def __getattr__(name: str) -> FastAPI:
    # `uvicorn pledge.api.app:app` builds the app on first use, so importing this module needs no database.
    if name == "app":
        return _from_environment()
    raise AttributeError(name)
