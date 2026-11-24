"""The browser step of a run, with a stand-in for node: what is recorded, for whom, and that it never raises."""

import json
import os
import stat

from pledge import local


def run_dir(tmp_path, failures):
    directory = tmp_path / "run"
    directory.mkdir()
    rows = [{"id": "a", "status": "pass"}, {"id": "b", "status": "fail" if failures else "pass", "failures": failures}]
    (directory / "result.json").write_text(json.dumps({"assertions": rows}))
    return directory


def fake_node(tmp_path, monkeypatch, script):
    node = tmp_path / "bin" / "node"
    node.parent.mkdir()
    node.write_text("#!/bin/sh\n" + script)
    node.chmod(node.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setenv("PATH", f"{node.parent}{os.pathsep}{os.environ['PATH']}")


def test_the_first_failing_journey_is_recorded_and_a_crash_keeps_what_was_made(tmp_path, monkeypatch):
    steps = tmp_path / "browser.cjs"
    steps.write_text("")
    # $3 is the output directory; the stand-in writes a trace, says whose journey it got, then fails.
    fake_node(tmp_path, monkeypatch, 'echo zip > "$3/trace.zip"; echo "boom for $PLEDGE_JOURNEY" >&2; exit 1\n')
    directory = run_dir(tmp_path, [{"logical_key": "j-7", "expected": 1, "actual": 2}, {"logical_key": "j-9"}])

    local._record_browser(steps, directory)

    assert json.loads((directory / "pledge" / "browser" / "browser.json").read_text()) == {"journey": "j-7", "files": ["trace.zip"], "error": "boom for j-7\n"}


def test_nothing_is_recorded_without_browser_steps_or_without_a_broken_journey(tmp_path):
    steps = tmp_path / "browser.cjs"
    broken = run_dir(tmp_path, [{"logical_key": "j-1"}])
    local._record_browser(steps, broken)  # the scenario has no browser steps
    steps.write_text("")
    (broken / "result.json").write_text(json.dumps({"assertions": [{"id": "b", "status": "fail", "failures": [{"expected": 1}]}]}))
    local._record_browser(steps, broken)  # a whole-run check failed: there is no one journey to sign in as
    assert not (broken / "pledge").exists()
