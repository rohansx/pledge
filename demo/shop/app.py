"""Demo shop: the app under test for Pledge's first loop. Standard library only.

    POST /orders    {"ref": "...", "amount": 1250}   create an order (safe to repeat)
    POST /payments  {"order_ref": "..."}             charge the order through the payment provider
    GET  /orders/<ref>                               the order and how many payments it has

It has one deliberate bug. POST /payments charges the provider every time it is called, so a customer whose
first reply is lost and who retries is charged twice. Run with SHOP_FIX=1 for the corrected behaviour.
"""

from __future__ import annotations

import json
import os
import sqlite3
import threading
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("PORT", "3000"))
PAYMENTS_URL = os.environ.get("PAYMENTS_URL", "http://127.0.0.1:4000")
DB_PATH = os.environ.get("SHOP_DB", "shop.db")
FIXED = os.environ.get("SHOP_FIX") == "1"

db = sqlite3.connect(DB_PATH, check_same_thread=False, isolation_level=None)
db.executescript(
    """
    create table if not exists orders (ref text primary key, amount integer not null, status text not null default 'pending');
    create table if not exists payments (id integer primary key, order_ref text not null, charge_id text not null);
    """
)
lock = threading.Lock()  # sqlite3 connections are not safe to share without one


def charge_provider(order_ref: str, amount: int) -> str:
    request = urllib.request.Request(
        f"{PAYMENTS_URL}/v1/charges",
        data=json.dumps({"order_ref": order_ref, "amount": amount}).encode(),
        headers={"content-type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        return json.load(response)["id"]


def pay(order_ref: str) -> tuple[int, dict]:
    with lock:
        row = db.execute("select amount, status from orders where ref = ?", (order_ref,)).fetchone()
    if row is None:
        return 404, {"error": "no such order"}
    amount, status = row
    if FIXED and status == "paid":
        # The fix: a retry of a payment that already went through is answered without charging again.
        return 200, {"order_ref": order_ref, "status": "paid"}
    try:
        charge_id = charge_provider(order_ref, amount)
    except (urllib.error.URLError, KeyError, ValueError, TimeoutError):
        return 502, {"error": "payment provider unavailable"}
    with lock:
        db.execute("insert into payments (order_ref, charge_id) values (?, ?)", (order_ref, charge_id))
        db.execute("update orders set status = 'paid' where ref = ?", (order_ref,))
    return 201, {"order_ref": order_ref, "status": "paid"}


class Handler(BaseHTTPRequestHandler):
    def _send(self, status: int, body: dict) -> None:
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _body(self) -> dict:
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("content-length") or 0)) or b"{}")
        except ValueError:
            return {}
        return body if isinstance(body, dict) else {}

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/healthz":
            self._send(200, {"ok": True})
            return
        if self.path.startswith("/orders/"):
            ref = self.path.removeprefix("/orders/")
            with lock:
                order = db.execute("select ref, amount, status from orders where ref = ?", (ref,)).fetchone()
                payments = db.execute("select count(*) from payments where order_ref = ?", (ref,)).fetchone()[0]
            if order:
                self._send(200, {"ref": order[0], "amount": order[1], "status": order[2], "payments": payments})
                return
        self._send(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        body = self._body()
        if self.path == "/orders":
            ref, amount = body.get("ref"), body.get("amount")
            if not isinstance(ref, str) or not ref or isinstance(amount, bool) or not isinstance(amount, int) or amount <= 0:
                self._send(400, {"error": "ref (string) and amount (positive integer) are required"})
                return
            with lock:
                db.execute("insert or ignore into orders (ref, amount) values (?, ?)", (ref, amount))
            self._send(201, {"ref": ref})
        elif self.path == "/payments":
            ref = body.get("order_ref")
            if not isinstance(ref, str) or not ref:
                self._send(400, {"error": "order_ref is required"})
                return
            self._send(*pay(ref))
        else:
            self._send(404, {"error": "not found"})

    def log_message(self, *args: object) -> None:
        pass


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
