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


def test_load_pledges_reads_valid_files_and_names_an_invalid_one(tmp_path):
    folder = tmp_path / ".pledge" / "pledges"
    folder.mkdir(parents=True)
    (folder / "a.json").write_text(json.dumps(pledge("a", "x")))

    assert [item["id"] for item in load_pledges(tmp_path)] == ["a"]

    (folder / "b.json").write_text(json.dumps(pledge("b", "x") | {"status": "maybe"}))
    with pytest.raises(PledgeError, match="b.json"):
        load_pledges(tmp_path)
