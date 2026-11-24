"""The browser step of a run, with a stand-in for node: what is recorded, for whom, and that it never raises."""

import json
import os
import stat
import urllib.parse
import zipfile

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
    # $3 is the output directory; the stand-in writes a trace, says whose journey it got and that nothing was typed, then fails.
    fake_node(tmp_path, monkeypatch, 'echo zip > "$3/trace.zip"; echo "boom for $PLEDGE_JOURNEY" >&2; echo "PLEDGE_SECRETS []"; exit 1\n')
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


def trace(path, files):
    with zipfile.ZipFile(path, "w") as archive:
        for name, data in files.items():
            archive.writestr(name, data)


def test_a_typed_secret_is_masked_in_every_file_of_the_trace_however_it_is_spelled(tmp_path):
    password = 'Tr1cky "pw" & ünï/code'
    files = {
        "trace.trace": json.dumps({"method": "fill", "params": {"value": password}}) + "\n" + json.dumps({"snapshot": json.dumps(["INPUT", {"__playwright_value_": password}])}),
        "resources/a.json": json.dumps({"email": "guest@example.com", "password": password}, ensure_ascii=False),
        "resources/b.txt": "password=" + urllib.parse.quote_plus(password),
        "resources/c.jpeg": b"\xff\xd8 not text",
    }
    trace(tmp_path / "trace.zip", files)

    local.scrub_trace(tmp_path / "trace.zip", ["Tr1ck", password[:9], password])  # typing key by key reports prefixes too

    with zipfile.ZipFile(tmp_path / "trace.zip") as archive:
        after = {name: archive.read(name) for name in archive.namelist()}
    assert list(after) == list(files) and after["resources/c.jpeg"] == b"\xff\xd8 not text"
    assert not any(b"Tr1cky" in data for data in after.values())
    assert json.loads(after["resources/a.json"]) == {"email": "guest@example.com", "password": "********"}
    assert after["resources/b.txt"] == b"password=********"
    lines = [json.loads(line) for line in after["trace.trace"].decode().splitlines()]
    assert lines[0]["params"] == {"value": "********"}
    assert json.loads(lines[1]["snapshot"]) == ["INPUT", {"__playwright_value_": "********"}]  # JSON inside JSON


def test_a_secret_stays_masked_around_a_character_the_page_encoded_its_own_way(tmp_path):
    # A form on a page that is not UTF-8 sends ü as %FC, and the trace's reading of that body has U+FFFD for it.
    trace(tmp_path / "trace.zip", {"body.dat": "password=correct-horse+%FC+battery", "trace.network": json.dumps({"value": "correct-horse � battery"})})

    local.scrub_trace(tmp_path / "trace.zip", ["correct-horse ü battery"])

    with zipfile.ZipFile(tmp_path / "trace.zip") as archive:
        after = b"".join(archive.read(name) for name in archive.namelist())
    assert b"horse" not in after and b"battery" not in after


def test_the_runners_report_of_what_was_typed_masks_the_trace_and_the_error_and_is_not_kept(tmp_path, monkeypatch):
    steps = tmp_path / "browser.cjs"
    steps.write_text("")
    trace(tmp_path / "made.zip", {"trace.trace": '{"value":"hunter2-long"}'})
    fake_node(tmp_path, monkeypatch, f'cp {tmp_path}/made.zip "$3/trace.zip"; echo "could not fill hunter2-long" >&2; echo \'PLEDGE_SECRETS ["hunter2-long"]\'; exit 1\n')

    info = local.record_browser(steps, tmp_path / "out", "j-1")

    assert info == {"journey": "j-1", "files": ["trace.zip"], "error": "could not fill ********\n"}
    assert zipfile.ZipFile(tmp_path / "out" / "trace.zip").read("trace.trace") == b'{"value":"********"}'
    assert "hunter2" not in (tmp_path / "out" / "browser.json").read_text()


def test_a_trace_is_dropped_when_the_runner_never_said_what_was_typed(tmp_path, monkeypatch):
    steps = tmp_path / "browser.cjs"
    steps.write_text("")
    fake_node(tmp_path, monkeypatch, 'echo zip > "$3/trace.zip"; echo png > "$3/screenshot.png"; exit 1\n')  # killed before its last line

    info = local.record_browser(steps, tmp_path / "out", "j-1")

    assert info["files"] == ["screenshot.png"] and "trace.zip dropped" in info["error"]
    assert not (tmp_path / "out" / "trace.zip").exists()
