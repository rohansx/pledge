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


def test_a_whole_run_failure_skips_setup_and_prefers_the_lost_reply_furthest_into_a_journey(tmp_path):
    traffic = [
        entry(1, "setup", "/login", returned=504, fault=0),
        entry(2, "j-1", "/lookup", returned=504, fault=0), entry(3, "j-1", "/lookup"), entry(4, "j-1", "/order"), entry(5, "j-1", "/capture"),
        entry(6, "j-3", "/lookup"), entry(7, "j-3", "/order"), entry(8, "j-3", "/capture", returned=504, fault=1), entry(9, "j-3", "/capture"),
    ]
    rec = recording(run_dir(tmp_path, {"id": "charges", "status": "fail"}, traffic), "charges", "x")

    assert rec["journey"] == "j-3" and rec["faults_hit"] == 1


def test_a_graphql_step_names_its_operation(tmp_path):
    step = entry(1, "j-1", "/graphql/", returned=504, fault=0) | {"request": '{"query":"mutation($id: ID!) { transactionRequestAction(id: $id) { x } }"}'}
    rec = recording(run_dir(tmp_path, {"id": "a", "status": "fail"}, [step]), "a", "x")

    assert rec["steps"][0]["text"].startswith("POST /graphql/ transactionRequestAction: the app did the work")


def test_no_recording_without_a_failure_or_without_journey_keys(tmp_path):
    passed = run_dir(tmp_path, {"id": "a", "status": "pass"}, TRAFFIC)
    assert recording(passed, "a", "x") is None

    (tmp_path / "result.json").write_text(json.dumps({"seed": 1, "assertions": [{"id": "a", "status": "fail"}]}))
    (tmp_path / "pledge" / "proxy_traffic.json").write_text(json.dumps([entry(1, None, "/x", fault=0)]))
    assert recording(tmp_path, "a", "x") is None


def test_each_kind_of_fault_is_told_in_plain_words(tmp_path):
    traffic = [
        entry(0, "j-1", "/hooks", fault=0) | {"kinds": ["duplicate"]},
        entry(5, "j-1", "/hooks", returned=None, fault=0) | {"kinds": ["duplicate"], "copy": True},
        entry(10, "j-1", "/pay", fault=1) | {"kinds": ["race"]},
        entry(10, "j-1", "/pay", upstream=409, returned=None, fault=1) | {"kinds": ["race"], "copy": True},
        entry(20, "j-1", "/slow", returned=504, fault=2) | {"kinds": ["delay", "retry"], "delay_ms": 800},
        entry(30, "j-1", "/charge", upstream=None, returned=502, fault=3) | {"kinds": ["restart"], "service": "app"},
        entry(40, "j-1", "/gone", upstream=None, returned=502),
    ]
    rec = recording(run_dir(tmp_path, {"id": "a", "status": "fail"}, traffic), "a", "x")
    told = [step["text"] for step in rec["steps"][:-1]]

    assert told[0] == "POST /hooks: the request will be delivered a second time, as a provider redelivering a webhook would. The client got 201."
    assert told[1] == "POST /hooks: the same request was delivered a second time, though nobody sent it twice. This time the app answered 201; nobody was waiting for that reply."
    assert "sent twice at the same instant" in told[2]
    assert "at the same instant as the first. This time the app answered 409" in told[3]
    assert told[4] == "POST /slow: the reply was held for 800 ms; the app did the work and answered 201, but the reply was lost. The client got 504."
    assert told[5] == "POST /charge: app was killed and started again while this request was in flight. The client got 502."
    assert told[6] == "POST /gone → app unreachable (502)"
    assert [step["actor"] for step in rec["steps"]] == ["fault"] * 6 + ["client", "check"]
    assert rec["faults_hit"] == 4  # a second delivery is part of its fault, not another one
