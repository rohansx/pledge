import pytest

from pledge.faults import PlanError, engine_kind, fingerprint, parse_plan

RETRY = {"kind": "retry", "target": "app POST /payments", "params": {"rate": 0.5}}


def plan(*faults, seed=7):
    return parse_plan({"schema_version": 1, "seed": seed, "faults": list(faults)})


def test_a_retry_fault_matches_its_route_method_and_path_only():
    fault = plan(RETRY).faults[0]

    assert plan(RETRY).matching("app", "POST", "/payments") == (fault,)
    assert plan(RETRY).matching("payments", "POST", "/payments") == ()
    assert plan(RETRY).matching("app", "GET", "/payments") == ()
    assert plan(RETRY).matching("app", "POST", "/orders") == ()


def test_a_target_path_may_use_wildcards():
    wild = plan({"kind": "retry", "target": "app POST /orders/*/pay"})

    assert wild.matching("app", "POST", "/orders/42/pay")
    assert not wild.matching("app", "POST", "/orders/42")


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


def one(kind, **params):
    return {"schema_version": 1, "seed": 1, "faults": [{"kind": kind, "target": "app POST /x", "params": params}]}


def test_each_kind_keeps_its_own_params_and_defaults():
    faults = plan(
        {"kind": "duplicate", "target": "app POST /hooks", "params": {"rate": 0.2, "delay_ms": 50, "mode": "concurrent"}},
        {"kind": "duplicate", "target": "app POST /hooks"},
        {"kind": "race", "target": "app POST /pay"},
        {"kind": "delay", "target": "payments POST /v1/charges", "params": {"ms": 800}},
        {"kind": "restart", "target": "payments POST /v1/charges", "params": {"service": "app", "after_ms": 20, "max": 2}},
    ).faults

    assert [f.kind for f in faults] == ["duplicate", "duplicate", "race", "delay", "restart"]
    assert (faults[0].rate, faults[0].delay_ms, faults[0].concurrent) == (0.2, 50, True)
    assert (faults[1].rate, faults[1].delay_ms, faults[1].concurrent) == (1.0, 0, False)
    assert faults[3].ms == 800
    assert (faults[4].service, faults[4].after_ms, faults[4].limit) == ("app", 20, 2)


def test_the_engines_names_for_a_kind_are_accepted_and_given_back():
    faults = plan({"kind": "duplicate_delivery", "target": "app POST /x"}, {"kind": "same_instant", "target": "app POST /x"}).faults

    assert [f.kind for f in faults] == ["duplicate", "race"]
    assert [engine_kind(kind) for kind in ("duplicate", "race", "delay", "restart", "retry")] == ["duplicate_delivery", "same_instant", "delay", "restart", "retry"]


def test_every_fault_covering_a_request_matches_and_each_fires_on_its_own_pattern():
    mixed = plan(RETRY, {"kind": "delay", "target": "app POST /pay*", "params": {"rate": 0.5, "ms": 10}})

    assert [f.kind for f in mixed.matching("app", "POST", "/payments")] == ["retry", "delay"]
    assert [mixed.fires(mixed.faults[0], n) for n in range(100)] != [mixed.fires(mixed.faults[1], n) for n in range(100)]
    assert [mixed.fires(mixed.faults[0], n) for n in range(100)] == [plan(RETRY).fires(plan(RETRY).faults[0], n) for n in range(100)]  # adding a fault moved nothing


@pytest.mark.parametrize(
    ("document", "message"),
    [
        ([], "schema_version 1"),
        ({"schema_version": 2, "seed": 1, "faults": []}, "schema_version 1"),
        ({"schema_version": 1, "seed": "1", "faults": []}, "seed must be an integer"),
        ({"schema_version": 1, "seed": True, "faults": []}, "seed must be an integer"),
        ({"schema_version": 1, "seed": 1, "faults": {}}, "faults must be a list"),
        ({"schema_version": 1, "seed": 1, "faults": [{"kind": "reorder", "target": "app POST /x"}]}, "cannot apply kind 'reorder'"),
        (one("restart"), "restart needs service"),
        (one("restart", service="app", max=0), "max must be an integer from 1"),
        (one("restart", service="app", after_ms=-1), "after_ms must be"),
        (one("delay"), "delay needs ms"),
        (one("delay", ms=0), "ms must be an integer from 1 to 60000"),
        (one("delay", ms=1.5), "ms must be"),
        (one("duplicate", mode="twice"), "mode must be one of after, concurrent"),
        (one("duplicate", delay_ms=True), "delay_ms must be"),
        (one("duplicate", status=500), "duplicate params may only be delay_ms, mode, rate"),
        (one("race", delay_ms=5), "race params may only be rate"),
        ({"schema_version": 1, "seed": 1, "faults": [{"kind": "retry", "target": "POST /x"}]}, "target must be"),
        ({"schema_version": 1, "seed": 1, "faults": [{"kind": "retry", "target": "app POST /x", "params": {"rate": 2}}]}, "rate must be"),
        ({"schema_version": 1, "seed": 1, "faults": [{"kind": "retry", "target": "app POST /x", "params": {"status": 200}}]}, "status must be"),
        ({"schema_version": 1, "seed": 1, "faults": [{"kind": "retry", "target": "app POST /x", "params": {"delay": 1}}]}, "may only be"),
    ],
)
def test_parse_plan_refuses_what_the_proxy_cannot_apply(document, message):
    with pytest.raises(PlanError, match=message):
        parse_plan(document)
