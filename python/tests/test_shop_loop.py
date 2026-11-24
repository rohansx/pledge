"""The Phase 1 exit criterion, end to end on this machine: the demo shop's double charge breaks the pledge under
the lost-reply fault, and the fixed shop keeps it. Needs k6 v2.2.0, so it is skipped where k6 is missing."""

import json
import shutil
from pathlib import Path

import pytest

from pledge import local
from pledge.verdict import verdict

SHOP = Path(__file__).resolve().parents[2] / "demo" / "shop"
FAULTS = SHOP / ".pledge" / "faults" / "lost-payment-reply.json"
REDELIVERED = SHOP / ".pledge" / "faults" / "redelivered-payment.json"
DOUBLE_CLICK = SHOP / ".pledge" / "faults" / "double-click-payment.json"
CRASH = SHOP / ".pledge" / "faults" / "crash-after-charge.json"

pytestmark = pytest.mark.skipif(shutil.which("k6") is None, reason="k6 is not installed")


def scan(tmp_path, env, faults=FAULTS, seeds=(1, 2)):
    tmp_path.mkdir(parents=True, exist_ok=True)
    (SHOP / local.STATE_DIR / "pids.json").unlink(missing_ok=True)
    local.boot(SHOP, {"SHOP_DB": str(tmp_path / "shop.db"), **env})
    try:
        runs = [local.run(SHOP, "checkout", faults, seed, tmp_path / "runs") for seed in seeds]
    finally:
        local.down(SHOP)
    return runs, verdict(SHOP, [Path(run["run_dir"]) for run in runs])


def test_the_buggy_shop_breaks_one_charge_per_order_when_payment_replies_are_lost(tmp_path):
    runs, report = scan(tmp_path, {})

    rows = {row["id"]: row for row in report["pledges"]}
    assert report["verdict"] == "broken"
    assert rows["one-charge-per-order"]["broken"] == 2
    assert rows["customer-payment-succeeds"]["result"] == "kept"  # every customer still ends up paid: the bug is silent
    assert all(run["faults_injected"] > 0 for run in runs)


def test_the_fixed_shop_keeps_every_pledge_under_the_same_fault(tmp_path):
    runs, report = scan(tmp_path, {"PAYMENTS_GUARD": "1"})

    assert report["verdict"] == "kept"
    assert all(run["faults_injected"] > 0 for run in runs)


def test_the_same_seed_injects_the_same_number_of_faults_on_both_versions(tmp_path):
    buggy, _ = scan(tmp_path / "a", {}, seeds=(5,))
    fixed, _ = scan(tmp_path / "b", {"PAYMENTS_GUARD": "1"}, seeds=(5,))

    assert buggy[0]["faults_injected"] == fixed[0]["faults_injected"]


def test_without_faults_the_bug_stays_hidden(tmp_path):
    _, report = scan(tmp_path, {}, faults=None, seeds=(1,))

    assert report["verdict"] == "kept"


def injected(run):
    return json.loads((Path(run["run_dir"]) / "pledge" / "proxy_injected.json").read_text())


def test_a_redelivered_payment_request_charges_the_buggy_shop_twice_though_no_customer_retried(tmp_path):
    runs, report = scan(tmp_path, {}, faults=REDELIVERED)

    rows = {row["id"]: row for row in report["pledges"]}
    assert rows["one-charge-per-order"]["broken"] == 2
    assert rows["customer-payment-succeeds"]["result"] == "kept"
    assert all(entry["kind"] == "duplicate" and entry["copy_status"] == 201 for run in runs for entry in injected(run))
    plan = json.loads((Path(runs[0]["run_dir"]) / "fault_plan.json").read_text())
    assert plan["faults"][0]["kind"] == "duplicate_delivery"  # recorded under the engine's name for it


def test_the_fixed_shop_keeps_one_charge_per_order_when_payment_requests_are_redelivered(tmp_path):
    runs, report = scan(tmp_path, {"PAYMENTS_GUARD": "1"}, faults=REDELIVERED)

    assert report["verdict"] == "kept"
    assert all(entry["copy_status"] == 200 for run in runs for entry in injected(run))  # the second delivery found the order paid


def test_two_payment_requests_at_the_same_instant_get_past_the_fix_that_stops_retries(tmp_path):
    _, report = scan(tmp_path, {"PAYMENTS_GUARD": "1"}, faults=DOUBLE_CLICK)

    rows = {row["id"]: row for row in report["pledges"]}
    assert rows["one-charge-per-order"]["broken"] >= 1  # check-then-charge: both saw the order unpaid


def test_a_shop_killed_after_the_charge_is_restarted_and_charges_again_when_the_customer_retries(tmp_path):
    runs, report = scan(tmp_path, {"PAYMENTS_GUARD": "1"}, faults=CRASH, seeds=(1,))

    restarts = injected(runs[0])
    assert [(entry["kind"], entry["service"], entry["error"]) for entry in restarts] == [("restart", "app", None)]
    rows = {row["id"]: row for row in report["pledges"]}
    assert rows["one-charge-per-order"]["broken"] == 1  # the provider was charged; the shop died before writing it down


def test_a_run_whose_restarted_service_did_not_come_back_fails_instead_of_giving_a_verdict(tmp_path):
    shop = tmp_path / "shop"
    shutil.copytree(SHOP, shop, ignore=shutil.ignore_patterns(local.STATE_DIR))
    recipe = json.loads((shop / local.BOOT_FILE).read_text())
    recipe["services"][1]["restart"] = ["sh", "-c", "echo cannot start >&2; exit 1"]  # the app's own restart command, failing
    (shop / local.BOOT_FILE).write_text(json.dumps(recipe))
    local.boot(shop, {"SHOP_DB": str(tmp_path / "shop.db")})
    try:
        with pytest.raises(RuntimeError, match="app did not come back after the restart fault: .*cannot start"):
            local.run(shop, "checkout", shop / ".pledge" / "faults" / CRASH.name, 1, tmp_path / "runs")
    finally:
        local.down(shop)
