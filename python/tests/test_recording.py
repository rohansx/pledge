import json

from pledge.recording import recording


def run_dir(tmp_path, assertion_row, traffic):
    (tmp_path / "pledge").mkdir()
    (tmp_path / "result.json").write_text(json.dumps({"seed": 3, "assertions": [assertion_row]}))
    (tmp_path / "pledge" / "proxy_traffic.json").write_text(json.dumps(traffic))
    return tmp_path


def entry(at, journey, path, upstream=201, returned=201, fault=None):
    return {"at_ms": at, "route": "app", "method": "POST", "path": path, "journey": journey, "upstream_status": upstream, "returned_status": returned, "fault": fault, "request": "{}", "reply": "{}"}


TRAFFIC = [
    entry(100, "j-1", "/leads"),
    entry(120, "j-2", "/leads", returned=504, fault=0),
    entry(350, "j-2", "/leads"),
    entry(400, None, "/other"),
]


def test_a_per_journey_failure_replays_the_journey_it_names(tmp_path):
    row = {"id": "one_lead", "status": "fail", "failures": [{"logical_key": "j-2", "expected": 1, "actual": 2}]}
    rec = recording(run_dir(tmp_path, row, TRAFFIC), "one_lead", "One lead per mention.")

    assert (rec["seed"], rec["journey"], rec["faults_hit"]) == (3, "j-2", 1)
    assert [(s["at"], s["actor"]) for s in rec["steps"]] == [(0, "fault"), (230, "client"), (230, "check")]
    assert "reply was lost" in rec["steps"][0]["text"]
    assert rec["steps"][-1]["text"] == "Broken: One lead per mention. (expected 1, found 2)"


def test_a_whole_run_failure_replays_the_first_journey_a_fault_hit(tmp_path):
    row = {"id": "charges_match", "status": "fail", "expected": 20, "actual": 26}
    rec = recording(run_dir(tmp_path, row, TRAFFIC), "charges_match", "Charges equal paid orders.")

    assert rec["journey"] == "j-2" and "(expected 20, found 26)" in rec["steps"][-1]["text"]


def test_no_recording_without_a_failure_or_without_journey_keys(tmp_path):
    passed = run_dir(tmp_path, {"id": "a", "status": "pass"}, TRAFFIC)
    assert recording(passed, "a", "x") is None

    (tmp_path / "result.json").write_text(json.dumps({"seed": 1, "assertions": [{"id": "a", "status": "fail"}]}))
    (tmp_path / "pledge" / "proxy_traffic.json").write_text(json.dumps([entry(1, None, "/x", fault=0)]))
    assert recording(tmp_path, "a", "x") is None
