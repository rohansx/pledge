"""A fake payment provider: accepts charges, answers plausibly, and records every call it receives.

    python -m pledge.fakes.payments --port 4000

    POST /v1/charges   {"order_ref": "...", "amount": 1250}  ->  201 {"id": "ch_1", "status": "succeeded"}
    GET  /_fake/calls     every charge received, in order
    GET  /_fake/summary   counts a pledge can be checked against
    POST /_fake/reset     forget everything (between runs that share one sandbox)

The call log is the evidence: "one charge per order" is checked against what this provider actually received.
"""

from __future__ import annotations

import argparse
import json
import threading
from collections import Counter
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MAX_BODY_BYTES = 64 * 1024


class Ledger:
    """Every charge received. Thread-safe: the server handles requests on many threads."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._charges: list[dict] = []

    def charge(self, order_ref: str, amount: int) -> dict:
        with self._lock:
            charge = {"id": f"ch_{len(self._charges) + 1}", "order_ref": order_ref, "amount": amount, "status": "succeeded"}
            self._charges.append(charge)
            return charge

    def calls(self) -> list[dict]:
        with self._lock:
            return list(self._charges)

    def reset(self) -> None:
        with self._lock:
            self._charges = []

    def summary(self) -> dict:
        per_order = Counter(charge["order_ref"] for charge in self.calls())
        return {
            "charges": sum(per_order.values()),
            "orders_charged": len(per_order),
            "orders_charged_more_than_once": sum(1 for count in per_order.values() if count > 1),
            "max_charges_per_order": max(per_order.values(), default=0),
        }


def make_handler(ledger: Ledger) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        def _send(self, status: int, body: object) -> None:
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self) -> None:  # noqa: N802 (http.server's naming)
            if self.path == "/_fake/calls":
                self._send(200, {"charges": ledger.calls()})
            elif self.path == "/_fake/summary":
                self._send(200, ledger.summary())
            elif self.path == "/healthz":
                self._send(200, {"ok": True})
            else:
                self._send(404, {"error": {"message": "not found"}})

        def do_POST(self) -> None:  # noqa: N802
            if self.path == "/_fake/reset":
                ledger.reset()
                self._send(200, {"ok": True})
                return
            if self.path != "/v1/charges":
                self._send(404, {"error": {"message": "not found"}})
                return
            length = int(self.headers.get("content-length") or 0)
            if length > MAX_BODY_BYTES:
                self._send(413, {"error": {"message": "body too large"}})
                return
            try:
                body = json.loads(self.rfile.read(length) or b"{}")
                order_ref, amount = body["order_ref"], body["amount"]
                if not isinstance(order_ref, str) or not order_ref or isinstance(amount, bool) or not isinstance(amount, int) or amount <= 0:
                    raise ValueError
            except (ValueError, KeyError, TypeError):
                self._send(400, {"error": {"message": "order_ref (string) and amount (positive integer) are required"}})
                return
            self._send(201, ledger.charge(order_ref, amount))

        def log_message(self, *args: object) -> None:  # the ledger is the log
            pass

    return Handler


def make_server(port: int, host: str = "127.0.0.1") -> ThreadingHTTPServer:
    return ThreadingHTTPServer((host, port), make_handler(Ledger()))


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="pledge.fakes.payments", description=__doc__.splitlines()[0])
    parser.add_argument("--port", type=int, default=4000)
    args = parser.parse_args(argv)
    server = make_server(args.port)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
