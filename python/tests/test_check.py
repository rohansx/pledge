"""What `check_author` accepts, with stand-ins for the engine and the baseline run: no k6, no app."""

import json
import shutil

import pytest

from pledge import check, local

UI = {"kind": "ui", "ref": "web/Seats.tsx:112", "retries": False, "double_submit": True, "redelivers": False, "evidence": "The Book button is not disabled while pending."}
CALLERS = {"schema_version": 1, "routes": [{"route": "POST /showings/*/bookings", "callers": [UI]}, {"route": "GET /showings/*", "callers": [UI]}]}
PLEDGE = {
    "schema_version": 1, "id": "seats-never-oversold", "statement": "A showing never has more seats booked than it holds.", "source": "stated", "status": "proposed",
    "check": {"scenario": "booking", "assertion": "seats_within_capacity"}, "reach": "ui", "trigger": "Two customers press Book for the last seat at once.",
}
TRAFFIC = [("app", "POST", "/showings/7/bookings"), ("app", "GET", "/showings/7?expand=seats"), ("tickets", "POST", "/print")]


@pytest.fixture
def app(tmp_path, monkeypatch):
    """A repository with one authored scenario, and a baseline run that sent TRAFFIC through the proxy."""
    directory = tmp_path / "app"
    (directory / "web").mkdir(parents=True)
    (directory / "web" / "Seats.tsx").write_text("export const Seats = () => null;\n")
    recipe = {"schema_version": 1, "services": [], "target": "http://127.0.0.1:18100", "routes": {"app": {"listen": 18100, "upstream": "http://127.0.0.1:13100"}, "tickets": {"listen": 18101, "upstream": "http://127.0.0.1:14100"}}}
    (directory / "pledge.boot.json").write_text(json.dumps(recipe))
    for folder in ("scenarios/booking", "pledges", "faults"):
        (directory / ".pledge" / folder).mkdir(parents=True)
    write(directory, "callers.json", CALLERS)
    write(directory, "pledges/seats-never-oversold.json", PLEDGE)
    write(directory, "faults/lost-reply.json", {"description": "x", "faults": [{"kind": "retry", "target": "app POST /showings/*/bookings", "params": {"rate": 0.5}}]})

    def run(app_dir, scenario, faults, seed, runs_dir):
        run_dir = runs_dir / f"run-{scenario}"
        (run_dir / "pledge").mkdir(parents=True)
        (run_dir / "result.json").write_text(json.dumps({"assertions": [{"id": "seats_within_capacity", "status": "pass"}]}))
        (run_dir / "pledge" / "proxy_traffic.json").write_text(json.dumps([{"route": route, "method": method, "path": path} for route, method, path in TRAFFIC]))
        return {"run_id": run_dir.name, "run_dir": str(run_dir), "verdict": "pass"}

    monkeypatch.setattr(check, "_inspect", lambda scenario: ({"ok": True, "assertions": ["seats_within_capacity"]}, ""))
    monkeypatch.setattr(local, "run", run)
    return directory


def write(app_dir, name, document):
    (app_dir / ".pledge" / name).write_text(json.dumps(document))


def problems(app_dir):
    return check.check_author(app_dir, app_dir.parent / "runs")["problems"]


def test_work_grounded_in_an_inventory_that_covers_every_request_is_accepted(app):
    report = check.check_author(app, app.parent / "runs")

    assert report["problems"] == []
    assert report["routes"] == ["GET /showings/*", "POST /showings/*/bookings"]  # the fake's route and the query string are not the app's routes


def test_without_a_caller_inventory_nothing_is_accepted(app):
    (app / ".pledge" / "callers.json").unlink()

    assert any("callers.json is missing" in problem for problem in problems(app))


def test_a_request_the_baseline_made_to_a_route_the_inventory_omits_is_named(app):
    write(app, "callers.json", {"schema_version": 1, "routes": CALLERS["routes"][:1]})

    found = problems(app)

    assert len(found) == 1 and "scenario booking: it calls routes .pledge/callers.json does not list (GET /showings/*)" in found[0]


def test_one_wildcard_cannot_stand_for_a_whole_api(app):
    write(app, "callers.json", {"schema_version": 1, "routes": [{"route": "POST /*", "callers": [UI]}, {"route": "GET /*", "callers": [UI]}, {"route": "POST /showings/*", "callers": [UI]}]})

    assert "faults file lost-reply.json: it repeats POST /showings/*/bookings" in problems(app)[0]

    (app / ".pledge" / "faults" / "lost-reply.json").unlink()  # the baseline runs only once everything else validates
    assert "(GET /showings/*, POST /showings/*/bookings)" in problems(app)[0]


def test_a_route_nothing_shipped_calls_is_listed_with_no_callers_and_its_pledge_is_api_only(app):
    write(app, "callers.json", {"schema_version": 1, "routes": [{"route": route["route"], "callers": []} for route in CALLERS["routes"]]})

    assert "reach is 'ui' but .pledge/callers.json lists no caller of that kind" in problems(app)[0]

    write(app, "pledges/seats-never-oversold.json", PLEDGE | {"reach": "api_only", "trigger": "No shipped client books twice; only a direct API caller could."})
    assert problems(app) == []


@pytest.mark.parametrize(
    ("change", "expected"),
    [
        ({"ref": "web/Missing.tsx"}, "caller ref web/Missing.tsx is not a file in the repository"),
        ({"ref": "../outside.txt"}, "is not a file in the repository"),
        ({"kind": "browser"}, "each caller needs kind (ui, client, provider, internal)"),
        ({"double_submit": "yes"}, "true or false for retries, double_submit, redelivers"),
        ({"evidence": ""}, "each caller needs kind"),
    ],
)
def test_a_caller_must_be_of_a_known_kind_say_how_it_repeats_and_point_at_a_file_in_the_repo(app, change, expected):
    (app.parent / "outside.txt").write_text("not the repository")
    write(app, "callers.json", {"schema_version": 1, "routes": [{"route": route["route"], "callers": [UI | change]} for route in CALLERS["routes"]]})

    assert any(expected in problem for problem in problems(app))


@pytest.mark.parametrize("document", ["not json", "[]", '{"schema_version": 1}', '{"schema_version": 1, "routes": [{"route": "bookings", "callers": []}]}'])
def test_a_malformed_inventory_is_rejected_with_what_it_needs(app, document):
    (app / ".pledge" / "callers.json").write_text(document)

    assert any(problem.startswith(".pledge/callers.json:") for problem in problems(app))


@pytest.mark.parametrize("missing", ["reach", "trigger"])
def test_a_new_pledge_must_say_who_can_break_it_and_how(app, missing):
    write(app, "pledges/seats-never-oversold.json", {key: value for key, value in PLEDGE.items() if key != missing})

    assert "pledge seats-never-oversold: needs `reach`" in problems(app)[0]


def test_a_fault_on_an_app_route_the_inventory_omits_is_rejected_but_one_on_a_third_party_route_is_not(app):
    faults = [{"kind": "retry", "target": "app POST /refunds", "params": {"rate": 1}}, {"kind": "retry", "target": "tickets POST /print", "params": {"rate": 1}}]
    write(app, "faults/lost-reply.json", {"description": "x", "faults": faults})

    found = problems(app)

    assert len(found) == 1 and found[0].startswith("faults file lost-reply.json: it repeats POST /refunds, a route .pledge/callers.json does not list")


@pytest.mark.skipif(shutil.which("node") is None, reason="node is not installed")
def test_browser_steps_must_load_and_stay_inside_the_sandbox(app):
    steps = app / ".pledge" / "scenarios" / "booking" / "browser.cjs"
    steps.write_text('module.exports = async (page) => { await page.goto("http://127.0.0.1:13200/login"); };\n')
    assert problems(app) == []

    steps.write_text('module.exports = async (page) => { await page.goto("https://cinema.example.com/login"); };\n')
    assert "names URLs outside the sandbox, which is closed: https://cinema.example.com/login" in problems(app)[0]

    steps.write_text("module.exports = async (page) => {\n")
    assert "scenario booking: browser.cjs does not load" in problems(app)[0]
