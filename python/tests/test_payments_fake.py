import json
import threading
import urllib.error
import urllib.request

import pytest

from pledge.fakes.payments import make_server


@pytest.fixture
def fake():
    server = make_server(0)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()
    server.server_close()


def call(method, url, body=None):
    data = None if body is None else json.dumps(body).encode()
    try:
        with urllib.request.urlopen(urllib.request.Request(url, data=data, method=method), timeout=5) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        return error.code, json.load(error)


def test_a_charge_succeeds_and_is_recorded(fake):
    status, charge = call("POST", f"{fake}/v1/charges", {"order_ref": "a", "amount": 1250})

    assert (status, charge) == (201, {"id": "ch_1", "order_ref": "a", "amount": 1250, "status": "succeeded"})
    assert call("GET", f"{fake}/_fake/calls")[1] == {"charges": [charge]}


def test_summary_counts_orders_charged_more_than_once(fake):
    for ref in ("a", "b", "a", "a"):
        call("POST", f"{fake}/v1/charges", {"order_ref": ref, "amount": 100})

    assert call("GET", f"{fake}/_fake/summary")[1] == {"charges": 4, "orders_charged": 2, "orders_charged_more_than_once": 1, "max_charges_per_order": 3}


def test_summary_of_nothing_is_all_zero(fake):
    assert call("GET", f"{fake}/_fake/summary")[1] == {"charges": 0, "orders_charged": 0, "orders_charged_more_than_once": 0, "max_charges_per_order": 0}


def test_reset_forgets_every_charge(fake):
    call("POST", f"{fake}/v1/charges", {"order_ref": "a", "amount": 100})

    assert call("POST", f"{fake}/_fake/reset", {})[0] == 200
    assert call("GET", f"{fake}/_fake/calls")[1] == {"charges": []}


@pytest.mark.parametrize("body", [{}, {"order_ref": "a"}, {"order_ref": "", "amount": 1}, {"order_ref": "a", "amount": 0}, {"order_ref": "a", "amount": "1"}, {"order_ref": "a", "amount": True}, []])
def test_a_malformed_charge_is_refused_and_not_recorded(fake, body):
    assert call("POST", f"{fake}/v1/charges", body)[0] == 400
    assert call("GET", f"{fake}/_fake/calls")[1] == {"charges": []}


def test_unknown_paths_are_404(fake):
    assert call("GET", f"{fake}/v1/charges")[0] == 404
    assert call("POST", f"{fake}/v1/refunds", {})[0] == 404
