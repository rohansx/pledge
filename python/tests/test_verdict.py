import json

import pytest

from pledge.verdict import PledgeError, format_verdict, judge, load_pledges


def pledge(id, assertion, status="approved", scenario="checkout"):
    return {"schema_version": 1, "id": id, "statement": f"{id} holds", "source": "inferred", "status": status, "check": {"scenario": scenario, "assertion": assertion}}


def counts(runs=3, **assertions):
    return {"runs": runs, "assertions": {name: {"pass": p, "fail": f, "unknown": runs - p - f, "failed_runs": [{"run_id": f"r{n}", "seed": n} for n in range(f)]} for name, (p, f) in assertions.items()}}


def test_a_pledge_is_broken_if_it_failed_in_any_run_and_kept_only_if_it_passed_in_all():
    report = judge([pledge("one-charge", "one_charge"), pledge("pays", "pays")], counts(one_charge=(1, 2), pays=(3, 0)), "checkout")

    rows = {row["id"]: row for row in report["pledges"]}
    assert report["verdict"] == "broken"
    assert (rows["one-charge"]["result"], rows["one-charge"]["kept"], rows["one-charge"]["broken"]) == ("broken", 1, 2)
    assert rows["one-charge"]["broken_in"] == [{"run_id": "r0", "seed": 0}, {"run_id": "r1", "seed": 1}]
    assert rows["pays"]["result"] == "kept"


def test_all_approved_pledges_kept_is_kept():
    assert judge([pledge("a", "x")], counts(x=(3, 0)), "checkout")["verdict"] == "kept"


def test_an_unknown_run_makes_a_pledge_inconclusive_not_kept():
    report = judge([pledge("a", "x")], counts(x=(2, 0)), "checkout")

    assert report["pledges"][0]["result"] == "inconclusive"
    assert report["verdict"] == "inconclusive"


@pytest.mark.parametrize("status", ["proposed", "proven"])
def test_only_an_approved_pledge_can_make_the_verdict_broken(status):
    report = judge([pledge("a", "x", status=status), pledge("b", "y")], counts(x=(0, 3), y=(3, 0)), "checkout")

    assert report["pledges"][0]["result"] == "broken"  # still reported
    assert report["verdict"] == "kept"  # but it does not block


def test_retired_pledges_and_pledges_for_other_scenarios_are_left_out():
    report = judge([pledge("a", "x", status="retired"), pledge("b", "x", scenario="refunds")], counts(x=(0, 3)), "checkout")

    assert report["pledges"] == []
    assert report["verdict"] == "inconclusive"


def test_a_pledge_whose_assertion_the_scenario_lacks_is_inconclusive():
    report = judge([pledge("a", "missing")], counts(x=(3, 0)), "checkout")

    assert report["pledges"][0]["result"] == "inconclusive"
    assert "inconclusive" in "\n".join(format_verdict(report))


def test_format_verdict_names_the_seeds_a_pledge_broke_on():
    lines = format_verdict(judge([pledge("one-charge", "x")], counts(x=(2, 1)), "checkout"))

    assert lines[0] == "BROKEN  scenario checkout  3 runs"
    assert lines[1] == "  one-charge: BROKEN  kept 2  broken 1  unknown 0  [approved]"
    assert lines[2] == "    broken on seed 0  r0"


def test_a_pledges_reach_and_trigger_reach_its_verdict_row_and_an_older_file_has_none():
    grounded = pledge("a", "x") | {"reach": "provider", "trigger": "The ticket printer redelivers its webhook."}
    report = judge([grounded, pledge("b", "y")], counts(x=(3, 0), y=(3, 0)), "checkout")

    assert [(row["reach"], row["trigger"]) for row in report["pledges"]] == [("provider", "The ticket printer redelivers its webhook."), ("unknown", "")]


@pytest.mark.parametrize("extra", [{"reach": "everyone"}, {"trigger": 7}])
def test_load_pledges_refuses_a_reach_or_trigger_it_does_not_know(tmp_path, extra):
    folder = tmp_path / ".pledge" / "pledges"
    folder.mkdir(parents=True)
    (folder / "a.json").write_text(json.dumps(pledge("a", "x") | extra))

    with pytest.raises(PledgeError, match="reach"):
        load_pledges(tmp_path)


def test_load_pledges_reads_valid_files_and_names_an_invalid_one(tmp_path):
    folder = tmp_path / ".pledge" / "pledges"
    folder.mkdir(parents=True)
    (folder / "a.json").write_text(json.dumps(pledge("a", "x")))

    assert [item["id"] for item in load_pledges(tmp_path)] == ["a"]

    (folder / "b.json").write_text(json.dumps(pledge("b", "x") | {"status": "maybe"}))
    with pytest.raises(PledgeError, match="b.json"):
        load_pledges(tmp_path)


def traffic_run(tmp_path, name, statuses, faulted=()):
    run_dir = tmp_path / name
    (run_dir / "pledge").mkdir(parents=True)
    entries = [{"route": "app", "returned_status": status, "fault": None} for status in statuses]
    entries += [{"route": "app", "returned_status": 504, "fault": 0} for _ in faulted]
    (run_dir / "pledge" / "proxy_traffic.json").write_text(json.dumps(entries))
    return run_dir


def test_a_run_is_app_down_only_when_no_unfaulted_request_succeeded(tmp_path):
    from pledge.verdict import app_down

    assert app_down(traffic_run(tmp_path, "login-500-then-401", [500] * 4 + [401] * 8))
    assert not app_down(traffic_run(tmp_path, "one-success", [500] * 9 + [201]))
    assert not app_down(traffic_run(tmp_path, "too-few", [500] * 4))
    assert not app_down(traffic_run(tmp_path, "only-faults-failed", [200] * 6, faulted=[1] * 6))
    assert not app_down(tmp_path)  # no traffic log at all: an older run, judged as before


def fault_run(tmp_path, name, faults, injected):
    run_dir = tmp_path / name
    (run_dir / "pledge").mkdir(parents=True)
    (run_dir / "fault_plan.json").write_text(json.dumps({"schema_version": 1, "seed": 1, "faults": faults}))
    if injected is not None:
        (run_dir / "pledge" / "proxy_injected.json").write_text(json.dumps(injected))
    return run_dir


def test_a_run_is_unfired_only_when_it_had_a_fault_plan_that_injected_nothing(tmp_path):
    from pledge.verdict import unfired

    plan = [{"kind": "retry", "target": "app POST /items", "params": {"rate": 0.5}}]
    assert unfired(fault_run(tmp_path, "other-scenarios-routes", plan, []))
    assert unfired(fault_run(tmp_path, "no-injection-log", plan, None))
    assert not unfired(fault_run(tmp_path, "fired", plan, [{"kind": "retry"}]))
    assert not unfired(fault_run(tmp_path, "baseline", [], []))
    assert not unfired(tmp_path)  # no plan recorded at all


# umami, seed 4 under lost-send-replies: the created team was missing from the list read, so the scenario had
# no team to count owners on and recorded no actual.
UNREAD = {"id": "team_has_one_owner", "status": "fail", "failed": 1, "samples": 20, "failures": [{"expected": 1, "actual": None, "logical_key": "j-15"}]}
MISSING = {"id": "team_created_once", "status": "fail", "failed": 1, "samples": 20, "failures": [{"expected": 1, "actual": 0, "logical_key": "j-15"}]}


def test_a_failure_counts_as_unknown_only_when_no_failing_journey_read_a_value():
    from pledge.verdict import mark

    assert mark(UNREAD, True) == "unknown"
    assert mark(MISSING, True) == "fail"  # it read the list and counted none: a value, and a real failure
    assert mark(UNREAD | {"failed": 14}, True) == "fail"  # thirteen failures the samples do not show
    assert mark(UNREAD | {"failures": [*UNREAD["failures"], MISSING["failures"][0]], "failed": 2}, True) == "fail"
    assert mark({"id": "stock_total", "status": "fail", "expected": 5, "actual": None}, True) == "fail"  # a whole-run observation is left alone
    assert mark(UNREAD | {"failures": [{"logical_key": "j-15"}]}, True) == "fail"  # a check that records no values is not one that could not read
    assert mark({"id": "x", "status": "pass"}, True) == "pass"
    assert mark({"id": "x", "status": "pass"}, False) == "unknown"  # the plan injected nothing
    assert mark(MISSING, False) == "fail"  # a failure needs no fault to be real


def test_discounting_a_run_moves_its_unread_failures_and_unfired_passes_to_unknown():
    from pledge.verdict import discount

    tallied = counts(runs=2, team_has_one_owner=(1, 1), team_created_once=(1, 1), pays=(2, 0))
    run = {"run_id": "r0", "assertions": [UNREAD, MISSING, {"id": "pays", "status": "pass"}, {"id": "not_tallied", "status": "pass"}]}

    discount(tallied, run, fired=False)

    assert tallied["assertions"]["team_has_one_owner"] == {"pass": 1, "fail": 0, "unknown": 1, "failed_runs": []}
    assert tallied["assertions"]["team_created_once"] == {"pass": 1, "fail": 1, "unknown": 0, "failed_runs": [{"run_id": "r0", "seed": 0}]}
    assert tallied["assertions"]["pays"] == {"pass": 1, "fail": 0, "unknown": 1, "failed_runs": []}
    report = judge([pledge("owner", "team_has_one_owner"), pledge("created", "team_created_once")], tallied, "checkout")
    assert [(row["id"], row["result"]) for row in report["pledges"]] == [("owner", "inconclusive"), ("created", "broken")]


def test_a_published_seed_shows_a_sample_that_read_a_value_and_is_unknown_when_none_did():
    from pledge.publish import _seed

    run = {"seed": 4, "run_id": "r4", "assertions": [UNREAD, UNREAD | {"id": "mixed", "failed": 2, "failures": [*UNREAD["failures"], MISSING["failures"][0]]}, {"id": "pays", "status": "pass"}]}

    assert _seed(run, "team_has_one_owner") == {"seed": 4, "run_id": "r4", "status": "unknown", "expected": 1, "failed": 1}
    assert _seed(run, "mixed") == {"seed": 4, "run_id": "r4", "status": "fail", "expected": 1, "actual": 0, "failed": 2}
    assert _seed(run, "pays", fired=False)["status"] == "unknown"
    assert _seed(run, "pays")["status"] == "pass"
