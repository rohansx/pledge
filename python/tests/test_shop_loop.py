"""The Phase 1 exit criterion, end to end on this machine: the demo shop's double charge breaks the pledge under
the lost-reply fault, and the fixed shop keeps it. Needs k6 v2.2.0, so it is skipped where k6 is missing."""

import shutil
from pathlib import Path

import pytest

from pledge import local
from pledge.verdict import verdict

SHOP = Path(__file__).resolve().parents[2] / "demo" / "shop"
FAULTS = SHOP / ".pledge" / "faults" / "lost-payment-reply.json"

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
    runs, report = scan(tmp_path, {"SHOP_FIX": "1"})

    assert report["verdict"] == "kept"
    assert all(run["faults_injected"] > 0 for run in runs)


def test_the_same_seed_injects_the_same_number_of_faults_on_both_versions(tmp_path):
    buggy, _ = scan(tmp_path / "a", {}, seeds=(5,))
    fixed, _ = scan(tmp_path / "b", {"SHOP_FIX": "1"}, seeds=(5,))

    assert buggy[0]["faults_injected"] == fixed[0]["faults_injected"]


def test_without_faults_the_bug_stays_hidden(tmp_path):
    _, report = scan(tmp_path, {}, faults=None, seeds=(1,))

    assert report["verdict"] == "kept"
