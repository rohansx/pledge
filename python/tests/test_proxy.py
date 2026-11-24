import asyncio
import socket

from aiohttp import ClientSession, web

from pledge.proxy import serve


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def with_proxy(scenario):
    """Run `scenario(http, proxy_url, admin_url, calls)` against a proxy in front of a counting upstream."""

    async def main():
        calls = []

        async def upstream(request: web.Request) -> web.Response:
            calls.append((request.method, request.path_qs, await request.text()))
            return web.json_response({"n": len(calls)}, status=201, headers={"X-From": "upstream"})

        app = web.Application()
        app.router.add_route("*", "/{tail:.*}", upstream)
        upstream_runner = web.AppRunner(app)
        await upstream_runner.setup()
        upstream_port, proxy_port, admin_port = free_port(), free_port(), free_port()
        await web.TCPSite(upstream_runner, "127.0.0.1", upstream_port).start()
        _, runners = await serve([("app", proxy_port, f"http://127.0.0.1:{upstream_port}")], admin_port)
        try:
            async with ClientSession() as http:
                await scenario(http, f"http://127.0.0.1:{proxy_port}", f"http://127.0.0.1:{admin_port}", calls)
        finally:
            for runner in [*runners, upstream_runner]:
                await runner.cleanup()

    asyncio.run(main())


def retry_plan(rate=1, seed=1):
    return {"schema_version": 1, "seed": seed, "faults": [{"kind": "retry", "target": "app POST /payments", "params": {"rate": rate}}]}


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
        bad = {"schema_version": 1, "seed": 1, "faults": [{"kind": "restart", "target": "app POST /x"}]}
        async with http.put(f"{admin}/plan", json=bad) as response:
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
