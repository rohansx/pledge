"""The fault proxy: a reverse proxy in front of the app and its dependencies that applies a fault plan.

    python -m pledge.proxy --route app=8080=http://127.0.0.1:3000 --route payments=8081=http://127.0.0.1:4000

Each route listens on its own port and forwards to one upstream. A separate admin port takes the plan
(PUT /plan), reports what was injected (GET /log) and answers GET /healthz. Everything binds to loopback.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import re
import time
from dataclasses import dataclass, field

from aiohttp import ClientError, ClientSession, ClientTimeout, web

from pledge.faults import EMPTY_PLAN, Plan, PlanError, fingerprint, parse_plan

log = logging.getLogger("pledge.proxy")

# Headers that describe one connection, not the message; never forwarded (RFC 9110 section 7.6.1).
HOP_BY_HOP = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length"}
MAX_BODY_BYTES = 8 * 1024 * 1024
UPSTREAM_TIMEOUT_SECONDS = 30
DEFAULT_ADMIN_PORT = 18089
JOURNEY_HEADER = "X-Pledge-Journey"  # scenarios send their journey key, so a broken journey can be replayed
MAX_TRAFFIC = 20_000  # ponytail: per run (one seed); later requests are dropped, raise if a scenario sends more
BODY_PREVIEW = 300
SECRET_FIELD = re.compile(r'("(?:[^"]*(?:password|secret|token|api_?key|authorization|card)[^"]*)"\s*:\s*)"[^"]*"', re.IGNORECASE)


def _preview(body: bytes) -> str:
    """The start of a body for the recording, with secret-looking JSON fields masked. A body that is not text
    (compressed, binary) is described, not shown: its bytes mean nothing on a page and can carry NULs."""
    try:
        text = body[: BODY_PREVIEW * 4].decode("utf-8")
    except UnicodeDecodeError as exc:
        if exc.start < BODY_PREVIEW * 4 - 4:  # not just a character cut in half by the slice
            return f"({len(body)} bytes, not text)"
        text = body[: exc.start].decode("utf-8")
    if "\x00" in text:
        return f"({len(body)} bytes, not text)"
    return SECRET_FIELD.sub(r'\1"***"', text)[:BODY_PREVIEW]


@dataclass
class State:
    """What the proxy remembers for the current plan. Replaced whole when a new plan is set."""

    plan: Plan = EMPTY_PLAN
    seen: set[str] = field(default_factory=set)  # fingerprints already attempted once
    matched: dict[int, int] = field(default_factory=dict)  # fault index -> new requests it has matched so far
    injected: list[dict] = field(default_factory=list)
    traffic: list[dict] = field(default_factory=list)  # every request, in arrival order
    started: float = field(default_factory=time.monotonic)


class Proxy:
    def __init__(self, routes: dict[str, str]) -> None:
        self.routes = routes  # route name -> upstream base URL
        self.state = State()
        self.session: ClientSession | None = None

    def route_app(self, route: str) -> web.Application:
        app = web.Application(client_max_size=MAX_BODY_BYTES)

        async def handle(request: web.Request) -> web.StreamResponse:
            return await self.forward(route, request)

        app.router.add_route("*", "/{tail:.*}", handle)
        return app

    def admin_app(self) -> web.Application:
        app = web.Application(client_max_size=MAX_BODY_BYTES)
        app.router.add_put("/plan", self.set_plan)
        app.router.add_get("/log", self.get_log)
        app.router.add_get("/healthz", self.healthz)
        return app

    async def forward(self, route: str, request: web.Request) -> web.StreamResponse:
        state = self.state  # one request sees one plan, even if the plan is replaced while it is in flight
        at = round((time.monotonic() - state.started) * 1000)
        body = await request.read()
        key = fingerprint(route, request.method, request.path_qs, body)
        first_attempt = key not in state.seen
        state.seen.add(key)
        fault = state.plan.matching(route, request.method, request.path) if first_attempt else None
        if fault is not None:
            ordinal = state.matched.get(fault.index, 0)
            state.matched[fault.index] = ordinal + 1
            if not state.plan.fires(fault, ordinal):
                fault = None

        headers = {name: value for name, value in request.headers.items() if name.lower() not in HOP_BY_HOP}
        assert self.session is not None
        try:
            async with self.session.request(request.method, self.routes[route] + request.path_qs, headers=headers, data=body, allow_redirects=False) as upstream:
                payload = await upstream.read()
                status = upstream.status
                reply_headers = {name: value for name, value in upstream.headers.items() if name.lower() not in HOP_BY_HOP}
        except (ClientError, asyncio.TimeoutError) as exc:
            log.warning("%s %s %s: upstream unreachable: %s", route, request.method, request.path, type(exc).__name__)
            self._record(state, route, request, body, at, None, 502, None, b"")
            return web.json_response({"error": "upstream unreachable"}, status=502)

        self._record(state, route, request, body, at, status, fault.status if fault else status, fault, payload)
        if fault is not None:
            # The upstream did the work and answered; the caller never hears about it.
            state.injected.append({"kind": "retry", "fault": fault.index, "route": route, "method": request.method, "path": request.path, "upstream_status": status, "returned_status": fault.status})
            return web.json_response({"error": "upstream timeout"}, status=fault.status)
        return web.Response(status=status, headers=reply_headers, body=payload)

    @staticmethod
    def _record(state: State, route: str, request: web.Request, body: bytes, at: int, upstream: int | None, returned: int, fault, payload: bytes) -> None:
        if len(state.traffic) >= MAX_TRAFFIC:
            return
        state.traffic.append({
            "at_ms": at, "route": route, "method": request.method, "path": request.path_qs[:300],
            "journey": request.headers.get(JOURNEY_HEADER), "upstream_status": upstream, "returned_status": returned,
            "fault": fault.index if fault else None, "request": _preview(body), "reply": _preview(payload),
        })

    async def set_plan(self, request: web.Request) -> web.Response:
        try:
            plan = parse_plan(await request.json())
        except (PlanError, json.JSONDecodeError) as exc:
            return web.json_response({"success": False, "data": None, "error": str(exc)}, status=422)
        self.state = State(plan=plan)
        return web.json_response({"success": True, "data": {"seed": plan.seed, "faults": len(plan.faults)}, "error": None})

    async def get_log(self, request: web.Request) -> web.Response:
        state = self.state
        return web.json_response({"success": True, "data": {"seed": state.plan.seed, "injected": state.injected, "traffic": state.traffic}, "error": None})

    async def healthz(self, request: web.Request) -> web.Response:
        return web.json_response({"success": True, "data": {"routes": sorted(self.routes)}, "error": None})


def parse_route(text: str) -> tuple[str, int, str]:
    """`app=8080=http://127.0.0.1:3000` -> ("app", 8080, "http://127.0.0.1:3000")."""
    name, _, rest = text.partition("=")
    port, _, upstream = rest.partition("=")
    if not name.isidentifier() or not port.isdigit() or not upstream.startswith(("http://", "https://")):
        raise argparse.ArgumentTypeError(f"route must look like NAME=PORT=http://HOST:PORT, got {text!r}")
    return name, int(port), upstream.rstrip("/")


async def serve(routes: list[tuple[str, int, str]], admin_port: int, host: str = "127.0.0.1") -> tuple[Proxy, list[web.AppRunner]]:
    """Start every listener; returns the proxy and the runners, which the caller cleans up."""
    proxy = Proxy({name: upstream for name, _, upstream in routes})
    proxy.session = ClientSession(timeout=ClientTimeout(total=UPSTREAM_TIMEOUT_SECONDS), auto_decompress=False)

    async def close_session(_: web.Application) -> None:
        await proxy.session.close()

    admin = proxy.admin_app()
    admin.on_cleanup.append(close_session)  # before setup(): a started app's signals are frozen
    runners = []
    for app, port in [(admin, admin_port), *((proxy.route_app(name), port) for name, port, _ in routes)]:
        runner = web.AppRunner(app, access_log=None)
        await runner.setup()
        await web.TCPSite(runner, host, port).start()
        runners.append(runner)
    return proxy, runners


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="pledge.proxy", description=__doc__.splitlines()[0])
    parser.add_argument("--route", action="append", required=True, type=parse_route, metavar="NAME=PORT=UPSTREAM")
    parser.add_argument("--admin-port", type=int, default=DEFAULT_ADMIN_PORT)
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")

    async def run() -> None:
        await serve(args.route, args.admin_port)
        log.info("routes %s, admin on :%s", ", ".join(f"{n}=:{p}->{u}" for n, p, u in args.route), args.admin_port)
        await asyncio.Event().wait()

    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
