import asyncio
import socket
import time

from aiohttp import ClientSession, web

from pledge.proxy import serve


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class Calls(list):
    """What the upstream received, and how many requests it was working on at once at most."""

    busy = 0
    peak = 0


def with_proxy(scenario, restart=None, work_seconds=0.0):
    """Run `scenario(http, proxy_url, admin_url, calls)` against a proxy in front of a counting upstream, which
    takes `work_seconds` over each request."""

    async def main():
        calls = Calls()

        async def upstream(request: web.Request) -> web.Response:
            calls.append((request.method, request.path_qs, await request.text()))
            n = len(calls)
            calls.busy += 1
            calls.peak = max(calls.peak, calls.busy)
            await asyncio.sleep(work_seconds)
            calls.busy -= 1
            return web.json_response({"n": n}, status=201, headers={"X-From": "upstream"})

        app = web.Application()
        app.router.add_route("*", "/{tail:.*}", upstream)
        upstream_runner = web.AppRunner(app)
        await upstream_runner.setup()
        upstream_port, proxy_port, admin_port = free_port(), free_port(), free_port()
        await web.TCPSite(upstream_runner, "127.0.0.1", upstream_port).start()
        _, runners = await serve([("app", proxy_port, f"http://127.0.0.1:{upstream_port}")], admin_port, restart=restart)
        try:
            async with ClientSession() as http:
                await scenario(http, f"http://127.0.0.1:{proxy_port}", f"http://127.0.0.1:{admin_port}", calls)
        finally:
            for runner in [*runners, upstream_runner]:
                await runner.cleanup()

    asyncio.run(main())


def retry_plan(rate=1, seed=1):
    return {"schema_version": 1, "seed": seed, "faults": [{"kind": "retry", "target": "app POST /payments", "params": {"rate": rate}}]}


def plan_of(kind, seed=1, **params):
    return {"schema_version": 1, "seed": seed, "faults": [{"kind": kind, "target": "app POST /payments", "params": params}]}


async def log_of(http, admin):
    async with http.get(f"{admin}/log") as response:
        return (await response.json())["data"]


def test_without_a_plan_requests_pass_through_unchanged():
    async def scenario(http, proxy, admin, calls):
        async with http.post(f"{proxy}/payments?x=1", data='{"order_ref":"a"}') as response:
            assert response.status == 201
            assert response.headers["X-From"] == "upstream"
            assert await response.json() == {"n": 1}
        assert calls == [("POST", "/payments?x=1", '{"order_ref":"a"}')]

    with_proxy(scenario)


def test_retry_fault_lets_the_upstream_act_but_loses_the_first_reply_only():
    async def scenario(http, proxy, admin, calls):
        async with http.put(f"{admin}/plan", json=retry_plan()) as response:
            assert response.status == 200
        async with http.post(f"{proxy}/payments", data='{"order_ref":"a"}') as first:
            assert first.status == 504
        assert len(calls) == 1  # the upstream did the work; only the reply was lost
        async with http.post(f"{proxy}/payments", data='{"order_ref":"a"}') as retry:
            assert retry.status == 201  # the retry of the same request is let through
        assert len(calls) == 2
        async with http.get(f"{admin}/log") as response:
            injected = (await response.json())["data"]["injected"]
        assert injected == [{"kind": "retry", "fault": 0, "route": "app", "method": "POST", "path": "/payments", "upstream_status": 201, "returned_status": 504}]

    with_proxy(scenario)


def test_requests_the_fault_does_not_target_are_untouched():
    async def scenario(http, proxy, admin, calls):
        await http.put(f"{admin}/plan", json=retry_plan())
        async with http.post(f"{proxy}/orders", data="{}") as response:
            assert response.status == 201
        async with http.get(f"{proxy}/payments") as response:
            assert response.status == 201

    with_proxy(scenario)


def test_setting_a_plan_forgets_the_previous_runs_requests_and_log():
    async def scenario(http, proxy, admin, calls):
        await http.put(f"{admin}/plan", json=retry_plan())
        async with http.post(f"{proxy}/payments", data="same") as response:
            assert response.status == 504
        await http.put(f"{admin}/plan", json=retry_plan())
        async with http.post(f"{proxy}/payments", data="same") as response:
            assert response.status == 504  # a first attempt again, under the new plan
        async with http.get(f"{admin}/log") as response:
            assert len((await response.json())["data"]["injected"]) == 1

    with_proxy(scenario)


def test_a_plan_the_proxy_cannot_apply_is_refused_and_the_old_plan_stays():
    async def scenario(http, proxy, admin, calls):
        bad = {"schema_version": 1, "seed": 1, "faults": [{"kind": "reorder", "target": "app POST /x"}]}
        async with http.put(f"{admin}/plan", json=bad) as response:
            assert response.status == 422
            assert "cannot apply kind 'reorder'" in (await response.json())["error"]
        # A restart needs something that owns the processes; this proxy was started with nothing to ask.
        async with http.put(f"{admin}/plan", json=plan_of("restart", service="app")) as response:
            assert response.status == 422
            assert "cannot apply kind 'restart'" in (await response.json())["error"]
        async with http.put(f"{admin}/plan", data="not json") as response:
            assert response.status == 422
        async with http.post(f"{proxy}/payments", data="x") as response:
            assert response.status == 201

    with_proxy(scenario)


def test_an_unreachable_upstream_is_a_502_not_a_crash():
    async def main():
        proxy_port, admin_port = free_port(), free_port()
        _, runners = await serve([("app", proxy_port, f"http://127.0.0.1:{free_port()}")], admin_port)
        try:
            async with ClientSession() as http, http.get(f"http://127.0.0.1:{proxy_port}/x") as response:
                assert response.status == 502
        finally:
            for runner in runners:
                await runner.cleanup()

    asyncio.run(main())


def test_traffic_log_records_every_request_with_its_journey_and_masks_secrets():
    async def scenario(http, proxy, admin, calls):
        async with http.put(f"{admin}/plan", json=retry_plan()) as response:
            assert response.status == 200
        body = '{"order_ref":"a","password":"hunter2"}'
        for _ in range(2):
            async with http.post(f"{proxy}/payments", data=body, headers={"X-Pledge-Journey": "j-1"}) as response:
                await response.read()
        async with http.get(f"{admin}/log") as response:
            traffic = (await response.json())["data"]["traffic"]
        assert [(t["journey"], t["upstream_status"], t["returned_status"], t["fault"]) for t in traffic] == [("j-1", 201, 504, 0), ("j-1", 201, 201, None)]
        assert "hunter2" not in traffic[0]["request"] and '"password":"***"' in traffic[0]["request"]

    with_proxy(scenario)


def test_a_body_that_is_not_text_is_described_not_shown():
    from pledge.proxy import _preview

    assert _preview(b"\x1f\x8b\x08\x00\xff\xfe") == "(6 bytes, not text)"
    assert _preview(b'{"a":"\x00"}') == "(9 bytes, not text)"
    assert _preview("é".encode() * 700) == "é" * 300  # a character split by the slice is not binary


def test_duplicate_gives_the_caller_one_normal_reply_and_delivers_the_request_again_afterwards():
    async def scenario(http, proxy, admin, calls):
        await http.put(f"{admin}/plan", json=plan_of("duplicate"))
        async with http.post(f"{proxy}/payments", data='{"event":"paid"}', headers={"X-Pledge-Journey": "j-1"}) as response:
            assert response.status == 201 and await response.json() == {"n": 1}  # the first delivery's own reply
        log = await log_of(http, admin)  # waits for the second delivery
        assert calls == [("POST", "/payments", '{"event":"paid"}')] * 2
        assert calls.peak == 1  # the second came after the first had finished
        assert log["injected"] == [{"kind": "duplicate", "fault": 0, "route": "app", "method": "POST", "path": "/payments", "copy_status": 201, "mode": "after", "delay_ms": 0}]
        assert [(t["journey"], t["kinds"], t.get("copy", False), t["returned_status"]) for t in log["traffic"]] == [("j-1", ["duplicate"], False, 201), ("j-1", ["duplicate"], True, None)]
        async with http.post(f"{proxy}/payments", data='{"event":"paid"}') as response:
            assert response.status == 201
        assert len(calls) == 3  # the caller's own repeat of a request is not a new request: no fault on it

    with_proxy(scenario, work_seconds=0.05)


def test_duplicate_can_wait_before_the_second_delivery_or_send_it_while_the_first_is_in_flight():
    async def scenario(http, proxy, admin, calls):
        await http.put(f"{admin}/plan", json=plan_of("duplicate", delay_ms=150))
        began = time.monotonic()
        async with http.post(f"{proxy}/payments", data="late") as response:
            assert response.status == 201
        assert len(calls) == 1 and time.monotonic() - began < 0.15  # the caller is not kept waiting for it
        await log_of(http, admin)
        assert len(calls) == 2 and time.monotonic() - began >= 0.15

        await http.put(f"{admin}/plan", json=plan_of("duplicate", mode="concurrent"))
        async with http.post(f"{proxy}/payments", data="together") as response:
            assert response.status == 201
        assert (await log_of(http, admin))["injected"][0]["mode"] == "concurrent"
        assert len(calls) == 4 and calls.peak == 2

    with_proxy(scenario, work_seconds=0.05)


def test_race_sends_the_request_twice_at_the_same_instant_and_returns_the_first_reply():
    async def scenario(http, proxy, admin, calls):
        await http.put(f"{admin}/plan", json=plan_of("race"))
        async with http.post(f"{proxy}/payments", data="click") as response:
            assert response.status == 201 and (await response.json())["n"] in (1, 2)
        log = await log_of(http, admin)
        assert calls == [("POST", "/payments", "click")] * 2 and calls.peak == 2
        assert log["injected"] == [{"kind": "race", "fault": 0, "route": "app", "method": "POST", "path": "/payments", "copy_status": 201}]
        assert [(t["kinds"], t.get("copy", False)) for t in log["traffic"]] == [(["race"], False), (["race"], True)]

    with_proxy(scenario, work_seconds=0.05)


def test_delay_holds_the_reply_after_the_upstream_did_the_work():
    async def scenario(http, proxy, admin, calls):
        await http.put(f"{admin}/plan", json=plan_of("delay", ms=200))
        began = time.monotonic()
        request = asyncio.ensure_future(http.post(f"{proxy}/payments", data="slow"))
        await asyncio.sleep(0.1)
        assert len(calls) == 1 and not request.done()  # the work is done; only the reply is held
        response = await request
        assert response.status == 201 and time.monotonic() - began >= 0.2
        log = await log_of(http, admin)
        assert log["injected"] == [{"kind": "delay", "fault": 0, "route": "app", "method": "POST", "path": "/payments", "ms": 200}]
        assert (log["traffic"][0]["kinds"], log["traffic"][0]["delay_ms"]) == (["delay"], 200)

    with_proxy(scenario)


def test_restart_asks_for_the_service_once_and_holds_new_traffic_until_it_is_back():
    asked = []

    async def restart(service):
        asked.append(service)
        await asyncio.sleep(0.2)  # the service coming back up

    async def scenario(http, proxy, admin, calls):
        await http.put(f"{admin}/plan", json=plan_of("restart", service="worker"))
        began = time.monotonic()
        first = asyncio.ensure_future(http.post(f"{proxy}/payments", data="a"))
        await asyncio.sleep(0.05)
        async with http.get(f"{proxy}/orders") as other:  # arrives while the service is down
            assert other.status == 201 and time.monotonic() - began >= 0.2
        assert (await first).status == 201  # this upstream was not the service that died
        async with http.post(f"{proxy}/payments", data="b") as response:
            assert response.status == 201
        assert asked == ["worker"]  # `max` defaults to one restart a run
        log = await log_of(http, admin)
        assert [(e["kind"], e["service"], e["error"]) for e in log["injected"]] == [("restart", "worker", None)]
        assert log["injected"][0]["took_ms"] >= 200
        assert [(t["kinds"], t.get("service")) for t in log["traffic"]] == [(["restart"], "worker"), ([], None), ([], None)]

    with_proxy(scenario, restart=restart)


def test_a_restart_that_failed_is_recorded_with_what_went_wrong():
    async def restart(service):
        return "app was not healthy after 90s"

    async def scenario(http, proxy, admin, calls):
        await http.put(f"{admin}/plan", json=plan_of("restart", service="app"))
        await http.post(f"{proxy}/payments", data="a")
        assert (await log_of(http, admin))["injected"][0]["error"] == "app was not healthy after 90s"

    with_proxy(scenario, restart=restart)


def test_a_plan_mixing_kinds_applies_every_fault_that_fires_on_a_request():
    async def scenario(http, proxy, admin, calls):
        faults = [
            {"kind": "delay", "target": "app POST /payments", "params": {"ms": 100}},
            {"kind": "retry", "target": "app POST /pay*"},
            {"kind": "duplicate", "target": "app POST /payments"},
            {"kind": "race", "target": "app POST /orders"},
        ]
        async with http.put(f"{admin}/plan", json={"schema_version": 1, "seed": 3, "faults": faults}) as response:
            assert response.status == 200
        began = time.monotonic()
        async with http.post(f"{proxy}/payments", data="x") as response:
            assert response.status == 504 and time.monotonic() - began >= 0.1  # held, then lost
        async with http.post(f"{proxy}/orders", data="y") as response:
            assert response.status == 201
        log = await log_of(http, admin)
        assert sorted(c[1] for c in calls) == ["/orders", "/orders", "/payments", "/payments"]
        assert sorted(e["kind"] for e in log["injected"]) == ["delay", "duplicate", "race", "retry"]
        assert log["traffic"][0]["kinds"] == ["duplicate", "delay", "retry"] and log["traffic"][0]["fault"] == 0

    with_proxy(scenario)
