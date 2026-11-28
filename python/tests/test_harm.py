from pledge.api.logic import harm
from pledge.publish import gap


def test_a_gap_is_how_far_one_journey_missed_in_the_apps_own_unit():
    assert gap({"psp_captured": 80}, {"saleor_charged": 40}) == 40
    assert gap({"lte": 40}, {"charge_status": "FULL", "psp_captured": 120, "saleor_charged": 40}) == 80
    assert gap({"gte": 3}, 1) == 2
    assert gap(1, 2) == 1
    assert gap({"a": 0, "b": 0}, {"a": 9, "b": 9}) is None  # two numbers each: no single gap
    assert gap({"eq": "FULL"}, "PARTIAL") is None


def test_harm_sums_journeys_and_gaps_over_failing_seeds_and_drops_the_gap_when_one_seed_lacks_it():
    seeds = [{"failed": 10, "samples": 20, "gap": 500.5}, {"failed": 9, "samples": 20, "gap": 409.5}]
    assert harm(seeds) == {"failed": 19, "samples": 40, "seeds": 2, "gap": 910.0}
    assert harm([*seeds, {"failed": 1, "samples": 20}])["gap"] is None
    assert harm([{"expected": 0, "actual": 9}]) is None
