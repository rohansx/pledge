import pytest

from pledge.faults import PlanError, fingerprint, parse_plan

RETRY = {"kind": "retry", "target": "app POST /payments", "params": {"rate": 0.5}}


def plan(*faults, seed=7):
    return parse_plan({"schema_version": 1, "seed": seed, "faults": list(faults)})


def test_a_retry_fault_matches_its_route_method_and_path_only():
    fault = plan(RETRY).faults[0]

    assert plan(RETRY).matching("app", "POST", "/payments") == fault
    assert plan(RETRY).matching("payments", "POST", "/payments") is None
    assert plan(RETRY).matching("app", "GET", "/payments") is None
    assert plan(RETRY).matching("app", "POST", "/orders") is None


def test_a_target_path_may_use_wildcards():
    wild = plan({"kind": "retry", "target": "app POST /orders/*/pay"})

    assert wild.matching("app", "POST", "/orders/42/pay") is not None
    assert wild.matching("app", "POST", "/orders/42") is None


def test_the_same_seed_fires_on_the_same_requests_and_another_seed_on_others():
    def pattern(seed):
        chosen = plan(RETRY, seed=seed)
        return [chosen.fires(chosen.faults[0], ordinal) for ordinal in range(200)]

    assert pattern(7) == pattern(7)
    assert pattern(7) != pattern(8)
    assert 70 < sum(pattern(7)) < 130  # about half of 200


def test_rate_bounds_always_and_never_fire():
    always = plan({"kind": "retry", "target": "app POST /x", "params": {"rate": 1}})
    never = plan({"kind": "retry", "target": "app POST /x", "params": {"rate": 0}})

    assert all(always.fires(always.faults[0], n) for n in range(50))
    assert not any(never.fires(never.faults[0], n) for n in range(50))


def test_a_retried_request_has_the_fingerprint_of_the_original():
    assert fingerprint("app", "POST", "/payments", b'{"a":1}') == fingerprint("app", "POST", "/payments", b'{"a":1}')
    assert fingerprint("app", "POST", "/payments", b'{"a":1}') != fingerprint("app", "POST", "/payments", b'{"a":2}')


@pytest.mark.parametrize(
    ("document", "message"),
    [
        ([], "schema_version 1"),
        ({"schema_version": 2, "seed": 1, "faults": []}, "schema_version 1"),
        ({"schema_version": 1, "seed": "1", "faults": []}, "seed must be an integer"),
        ({"schema_version": 1, "seed": True, "faults": []}, "seed must be an integer"),
        ({"schema_version": 1, "seed": 1, "faults": {}}, "faults must be a list"),
        ({"schema_version": 1, "seed": 1, "faults": [{"kind": "restart", "target": "app POST /x"}]}, "cannot apply kind 'restart'"),
        ({"schema_version": 1, "seed": 1, "faults": [{"kind": "retry", "target": "POST /x"}]}, "target must be"),
        ({"schema_version": 1, "seed": 1, "faults": [{"kind": "retry", "target": "app POST /x", "params": {"rate": 2}}]}, "rate must be"),
        ({"schema_version": 1, "seed": 1, "faults": [{"kind": "retry", "target": "app POST /x", "params": {"status": 200}}]}, "status must be"),
        ({"schema_version": 1, "seed": 1, "faults": [{"kind": "retry", "target": "app POST /x", "params": {"delay": 1}}]}, "may only be"),
    ],
)
def test_parse_plan_refuses_what_the_proxy_cannot_apply(document, message):
    with pytest.raises(PlanError, match=message):
        parse_plan(document)
