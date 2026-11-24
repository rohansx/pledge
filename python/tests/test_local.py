"""Restarting one service of a booted app, with the payments fake standing in for the app."""

import json
import socket

import pytest

from pledge import local


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
