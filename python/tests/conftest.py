from pathlib import Path

import pytest


@pytest.fixture(autouse=True)
def services_run_the_code_under_test(monkeypatch):
    """Booted services and the proxy are separate processes started in the app's directory. A relative
    PYTHONPATH would not reach them there, and they would import whichever pledge is installed instead."""
    monkeypatch.setenv("PYTHONPATH", str(Path(__file__).resolve().parents[1]))
