"""Restarting one service of a booted app, with the payments fake standing in for the app."""

import json
import socket

import pytest

from pledge import local
from pledge.check import check_author


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


@pytest.fixture
def booted(tmp_path):
    """A booted app directory with one service, `ledger`, and its base URL."""
    port = free_port()
    url = f"http://127.0.0.1:{port}"

    def boot(**service):
        recipe = {
            "schema_version": 1, "target": url, "routes": {"ledger": {"listen": free_port(), "upstream": url}},
            "services": [{"name": "ledger", "command": ["python3", "-m", "pledge.fakes.payments", "--port", str(port)], "health": f"{url}/healthz", **service}],
        }
        (tmp_path / local.BOOT_FILE).write_text(json.dumps(recipe))
        local.boot(tmp_path, {"EXTRA": "1"})
        return tmp_path, url

    yield boot
    local.down(tmp_path)


def pids(app_dir):
    return json.loads((app_dir / local.STATE_DIR / "pids.json").read_text())


def test_restart_kills_the_service_and_brings_a_new_healthy_one_up(booted):
    app_dir, url = booted()
    local._http("POST", f"{url}/v1/charges", {"order_ref": "a", "amount": 5})
    before = pids(app_dir)

    assert local.restart_service(app_dir, "ledger") == {"restarted": "ledger"}

    after = pids(app_dir)
    assert after["ledger"] != before["ledger"] and after["proxy"] == before["proxy"]
    assert local._http("GET", f"{url}/_fake/summary")["charges"] == 0  # what it held in memory died with it


def test_a_service_with_its_own_restart_command_is_restarted_by_that_and_not_killed(booted):
    app_dir, url = booted(restart=["sh", "-c", "echo $EXTRA > restarted"])
    before = pids(app_dir)

    local.restart_service(app_dir, "ledger")

    assert (app_dir / "restarted").read_text() == "1\n"  # run in the app directory, with the environment boot was given
    assert pids(app_dir) == before


def test_restart_refuses_a_service_the_recipe_does_not_name_and_a_command_that_fails(booted):
    app_dir, _ = booted(restart=["sh", "-c", "echo no such container >&2; exit 1"])

    with pytest.raises(local.BootError, match="no service named 'db'"):
        local.restart_service(app_dir, "db")
    with pytest.raises(local.BootError, match="restart command exited 1: no such container"):
        local.restart_service(app_dir, "ledger")


def app_with_faults(tmp_path, *faults):
    """An app directory that is not booted: a recipe with one service, `app`, and one faults file."""
    recipe = {"schema_version": 1, "target": "http://127.0.0.1:1", "routes": {}, "services": [{"name": "app", "command": ["true"], "health": "http://127.0.0.1:1/"}]}
    (tmp_path / local.BOOT_FILE).write_text(json.dumps(recipe))
    (tmp_path / ".pledge" / "faults").mkdir(parents=True)
    (tmp_path / ".pledge" / "faults" / "crash.json").write_text(json.dumps({"faults": list(faults)}))
    return tmp_path / ".pledge" / "faults" / "crash.json"


def test_a_run_whose_plan_restarts_an_unknown_service_or_cannot_be_applied_stops_before_anything_is_sent(tmp_path):
    faults = app_with_faults(tmp_path, {"kind": "restart", "target": "app POST /x", "params": {"service": "db"}})
    with pytest.raises(RuntimeError, match=r"restarts \['db'\], which pledge.boot.json does not list"):
        local.run(tmp_path, "checkout", faults, 1, tmp_path / "runs")

    faults.write_text(json.dumps({"faults": [{"kind": "reorder", "target": "app POST /x"}]}))
    with pytest.raises(RuntimeError, match="fault plan: .*cannot apply kind 'reorder'"):
        local.run(tmp_path, "checkout", faults, 1, tmp_path / "runs")


def test_the_authors_check_names_a_restart_of_a_service_the_recipe_does_not_have(tmp_path):
    app_with_faults(tmp_path, {"kind": "restart", "target": "app POST /x", "params": {"service": "app"}}, {"kind": "restart", "target": "app POST /x", "params": {"service": "db"}})

    problems = check_author(tmp_path, tmp_path / "runs")["problems"]

    assert [p for p in problems if "faults file" in p] == ["faults file crash.json: faults[1] restarts 'db', which pledge.boot.json does not list as a service"]
