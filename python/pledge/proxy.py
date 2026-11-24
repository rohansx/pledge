"""The fault proxy: a reverse proxy in front of the app and its dependencies that applies a fault plan.

    python -m pledge.proxy --route app=8080=http://127.0.0.1:3000 --route payments=8081=http://127.0.0.1:4000

Each route listens on its own port and forwards to one upstream. A separate admin port takes the plan
(PUT /plan), reports what was injected (GET /log) and answers GET /healthz. Everything binds to loopback.

The proxy cannot restart a service itself: it does not own the processes. With --app-dir it asks `pledge
restart APP_DIR SERVICE`, which does (see pledge.local.restart_service); without it, a plan with a
`restart` fault is refused.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import re
import sys
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field

from aiohttp import ClientError, ClientSession, ClientTimeout, web

from pledge.faults import EMPTY_PLAN, Fault, Plan, PlanError, fingerprint, parse_plan

log = logging.getLogger("pledge.proxy")

# Headers that describe one connection, not the message; never forwarded (RFC 9110 section 7.6.1).
HOP_BY_HOP = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length"}
MAX_BODY_BYTES = 8 * 1024 * 1024
UPSTREAM_TIMEOUT_SECONDS = 30
DEFAULT_ADMIN_PORT = 18089
JOURNEY_HEADER = "X-Pledge-Journey"  # scenarios send their journey key, so a broken journey can be replayed
MAX_TRAFFIC = 20_000  # ponytail: per run (one seed); later requests are dropped, raise if a scenario sends more
BODY_PREVIEW = 300
APPLY_ORDER = ("restart", "race", "duplicate", "delay", "retry")  # how the faults that fired on one request are listed
Reply = tuple[int, dict[str, str], bytes]  # status, headers, body
Restart = Callable[[str], Awaitable[str | None]]  # restarts the named service; returns what went wrong, if anything
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
    restarts: dict[int, int] = field(default_factory=dict)  # fault index -> restarts it has caused so far
    pending: set[asyncio.Future] = field(default_factory=set)  # second deliveries still on their way
    injected: list[dict] = field(default_factory=list)
    traffic: list[dict] = field(default_factory=list)  # every request, in arrival order
    started: float = field(default_factory=time.monotonic)


class Proxy:
    def __init__(self, routes: dict[str, str], restart: Restart | None = None) -> None:
        self.routes = routes  # route name -> upstream base URL
        self.restart = restart
        self.gate = asyncio.Lock()  # held while a service restarts, so that no new request meets a half-started app
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
        async with self.gate:  # wait out a restart; requests already past this point fail as they would in a crash
            pass
        state = self.state  # one request sees one plan, even if the plan is replaced while it is in flight
        at = round((time.monotonic() - state.started) * 1000)
        body = await request.read()
        key = fingerprint(route, request.method, request.path_qs, body)
        first_attempt = key not in state.seen
        state.seen.add(key)
        fired = self._fired(state, route, request) if first_attempt else {}

        headers = {name: value for name, value in request.headers.items() if name.lower() not in HOP_BY_HOP}
        url = self.routes[route] + request.path_qs
        what = {"route": route, "method": request.method, "path": request.path}

        def send() -> asyncio.Future[Reply | None]:
            return asyncio.ensure_future(self._send(request.method, url, headers, body))

        def deliver_again(fault: Fault, again: Callable[[], Awaitable[Reply | None]], delay_ms: int = 0) -> None:
            task = asyncio.ensure_future(self._second_delivery(state, fault, route, request, body, again, delay_ms))
            state.pending.add(task)  # also keeps the task alive: the loop holds tasks weakly
            task.add_done_callback(state.pending.discard)

        call = send()
        twin = send() if "race" in fired else None
        duplicate = fired.get("duplicate")
        if duplicate and duplicate.concurrent:
            deliver_again(duplicate, send, duplicate.delay_ms)
        extra: dict = {}
        if restart := fired.get("restart"):
            assert self.restart is not None  # set_plan refused the plan otherwise
            await asyncio.sleep(restart.after_ms / 1000)
            async with self.gate:
                began = time.monotonic()
                error = await self.restart(restart.service)
            if error:
                log.warning("restart of %s failed: %s", restart.service, error)
            state.injected.append({"kind": "restart", "fault": restart.index, **what, "service": restart.service, "took_ms": round((time.monotonic() - began) * 1000), "error": error})
            extra["service"] = restart.service
        if twin is not None:
            await asyncio.wait({call, twin}, return_when=asyncio.FIRST_COMPLETED)
            if not call.done():
                call, twin = twin, call
            loser = twin
            deliver_again(fired["race"], lambda: loser)
        reply = await call
        if delay := fired.get("delay"):
            await asyncio.sleep(delay.ms / 1000)
            state.injected.append({"kind": "delay", "fault": delay.index, **what, "ms": delay.ms})
            extra["delay_ms"] = delay.ms
        if duplicate and not duplicate.concurrent:
            deliver_again(duplicate, send, duplicate.delay_ms)

        if reply is None:
            log.warning("%s %s %s: upstream unreachable", route, request.method, request.path)
            fired.pop("retry", None)  # there is no reply to lose
            self._record(state, route, request, body, at, None, 502, fired, b"", **extra)
            return web.json_response({"error": "upstream unreachable"}, status=502)
        status, reply_headers, payload = reply
        retry = fired.get("retry")
        self._record(state, route, request, body, at, status, retry.status if retry else status, fired, payload, **extra)
        if retry is not None:
            # The upstream did the work and answered; the caller never hears about it.
            state.injected.append({"kind": "retry", "fault": retry.index, **what, "upstream_status": status, "returned_status": retry.status})
            return web.json_response({"error": "upstream timeout"}, status=retry.status)
        return web.Response(status=status, headers=reply_headers, body=payload)

    @staticmethod
    def _fired(state: State, route: str, request: web.Request) -> dict[str, Fault]:
        """The faults that fire on this new request, by kind. Every matching fault counts the request, fired or
        not; of two that fire with the same kind, the earlier in the plan is applied."""
        fired: dict[str, Fault] = {}
        for fault in state.plan.matching(route, request.method, request.path):
            ordinal = state.matched.get(fault.index, 0)
            state.matched[fault.index] = ordinal + 1
            if fault.kind in fired or not state.plan.fires(fault, ordinal):
                continue
            if fault.kind == "restart":
                if state.restarts.get(fault.index, 0) >= fault.limit:
                    continue
                state.restarts[fault.index] = state.restarts.get(fault.index, 0) + 1
            fired[fault.kind] = fault
        return fired

    async def _send(self, method: str, url: str, headers: dict[str, str], body: bytes) -> Reply | None:
        """One delivery to the upstream. None when it could not be reached or died before answering."""
        assert self.session is not None
        try:
            async with self.session.request(method, url, headers=headers, data=body, allow_redirects=False) as upstream:
                payload = await upstream.read()
                return upstream.status, {name: value for name, value in upstream.headers.items() if name.lower() not in HOP_BY_HOP}, payload
        except (ClientError, asyncio.TimeoutError):
            return None

    async def _second_delivery(self, state: State, fault: Fault, route: str, request: web.Request, body: bytes, again: Callable[[], Awaitable[Reply | None]], delay_ms: int) -> None:
        """The same request reaching the upstream once more. Nobody waits for this reply; it is only recorded."""
        await asyncio.sleep(delay_ms / 1000)
        at = round((time.monotonic() - state.started) * 1000)
        reply = await again()
        status, payload = (reply[0], reply[2]) if reply else (None, b"")
        self._record(state, route, request, body, at, status, None, {fault.kind: fault}, payload, copy=True)
        entry = {"kind": fault.kind, "fault": fault.index, "route": route, "method": request.method, "path": request.path, "copy_status": status}
        if fault.kind == "duplicate":
            entry |= {"mode": "concurrent" if fault.concurrent else "after", "delay_ms": delay_ms}
        state.injected.append(entry)

    @staticmethod
    def _record(state: State, route: str, request: web.Request, body: bytes, at: int, upstream: int | None, returned: int | None, fired: dict[str, Fault], payload: bytes, **extra: object) -> None:
        """One line of the traffic log. `kinds` says what was done to the request; `copy` marks a delivery the
        proxy made itself, whose reply went to nobody (`returned_status` is null)."""
        if len(state.traffic) >= MAX_TRAFFIC:
            return
        state.traffic.append({
            "at_ms": at, "route": route, "method": request.method, "path": request.path_qs[:300],
            "journey": request.headers.get(JOURNEY_HEADER), "upstream_status": upstream, "returned_status": returned,
            "fault": min((fault.index for fault in fired.values()), default=None), "kinds": [kind for kind in APPLY_ORDER if kind in fired],
            "request": _preview(body), "reply": _preview(payload), **extra,
        })

    async def set_plan(self, request: web.Request) -> web.Response:
        try:
            plan = parse_plan(await request.json())
        except (PlanError, json.JSONDecodeError) as exc:
            return web.json_response({"success": False, "data": None, "error": str(exc)}, status=422)
        if self.restart is None and any(fault.kind == "restart" for fault in plan.faults):
            return web.json_response({"success": False, "data": None, "error": "this proxy cannot apply kind 'restart': it was started without --app-dir, so it has nothing to ask for a restart"}, status=422)
        self.state = State(plan=plan)
        return web.json_response({"success": True, "data": {"seed": plan.seed, "faults": len(plan.faults)}, "error": None})

    async def get_log(self, request: web.Request) -> web.Response:
        state = self.state
        if state.pending:  # the log of a run is complete only once every second delivery has landed
            await asyncio.wait(set(state.pending))
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


def restart_through_cli(app_dir: str) -> Restart:
    """Ask `pledge restart`, which owns the service processes. A separate process, so the proxy holds no
    process ids and a proxy replaced mid-scan (restart_proxy) needs nothing handed over."""

    async def restart(service: str) -> str | None:
        process = await asyncio.create_subprocess_exec(sys.executable, "-m", "pledge.cli", "restart", app_dir, service, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
        output, _ = await process.communicate()
        return None if process.returncode == 0 else output.decode(errors="replace")[-500:] or f"exit {process.returncode}"

    return restart


async def serve(routes: list[tuple[str, int, str]], admin_port: int, host: str = "127.0.0.1", restart: Restart | None = None) -> tuple[Proxy, list[web.AppRunner]]:
    """Start every listener; returns the proxy and the runners, which the caller cleans up."""
    proxy = Proxy({name: upstream for name, _, upstream in routes}, restart)
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
    parser.add_argument("--app-dir", help="the booted app directory; lets a `restart` fault restart its services")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")

    async def run() -> None:
        await serve(args.route, args.admin_port, restart=restart_through_cli(args.app_dir) if args.app_dir else None)
        log.info("routes %s, admin on :%s", ", ".join(f"{n}=:{p}->{u}" for n, p, u in args.route), args.admin_port)
        await asyncio.Event().wait()

    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
