"""A stand-in for api.github.com on a local port: the handful of routes Pledge calls, and a log of every call."""

import io
import json
import re
import tarfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SHA = "a" * 40
BASE_SHA = "b" * 40


def tarball(files: dict[str, str], root: str = "o-r-aaaaaaa") -> bytes:
    """A repository archive as GitHub serves it: everything under one directory."""
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
        for path, text in files.items():
            info = tarfile.TarInfo(f"{root}/{path}")
            info.size = len(text.encode())
            archive.addfile(info, io.BytesIO(text.encode()))
    return buffer.getvalue()


class FakeGitHub:
    def __init__(self) -> None:
        self.calls: list[dict] = []  # {"method", "path", "auth", "accept", "body"}
        self.comments: list[dict] = []
        self.checks: dict[int, dict] = {}
        self.diff = ""
        self.pull = {"title": "Charge once", "body": "Stops double charges."}
        self.tree = tarball({"README.md": "hi"})
        self.commits = {SHA}  # the commits the tarball is served for
        self.fail: dict[str, int] = {}  # "METHOD /path-prefix" -> status to answer instead
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args) -> None:
                pass

            def _serve(self) -> None:
                length = int(self.headers.get("content-length") or 0)
                body = json.loads(self.rfile.read(length)) if length else None
                fake.calls.append({"method": self.command, "path": self.path, "auth": self.headers.get("authorization"), "accept": self.headers.get("accept"), "body": body})
                status, payload = fake.answer(self.command, self.path, self.headers.get("accept", ""), body)
                data = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            do_GET = do_POST = do_PATCH = _serve

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self._server.server_port}"
        threading.Thread(target=self._server.serve_forever, daemon=True).start()

    def close(self) -> None:
        self._server.shutdown()
        self._server.server_close()

    def paths(self, method: str | None = None) -> list[str]:
        return [f"{call['method']} {call['path'].split('?')[0]}" for call in self.calls if method in (None, call["method"])]

    def answer(self, method: str, path: str, accept: str, body: dict | None) -> tuple[int, object]:
        path = path.split("?")[0]
        for prefix, status in self.fail.items():
            if f"{method} {path}".startswith(prefix):
                return status, {"message": "Resource not accessible by integration"}
        if method == "POST" and re.fullmatch(r"/app/installations/\d+/access_tokens", path):
            return 201, {"token": "installation-token"}
        if method == "POST" and path == "/repos/o/r/check-runs":
            check_id = 100 + len(self.checks)
            self.checks[check_id] = dict(body)
            return 201, {"id": check_id}
        if method == "PATCH" and (match := re.fullmatch(r"/repos/o/r/check-runs/(\d+)", path)):
            self.checks[int(match.group(1))].update(body)
            return 200, {"id": int(match.group(1))}
        if method == "GET" and re.fullmatch(r"/repos/o/r/issues/\d+/comments", path):
            return 200, self.comments
        if method == "POST" and re.fullmatch(r"/repos/o/r/issues/\d+/comments", path):
            self.comments.append({"id": 500 + len(self.comments), "body": body["body"], "user": {"type": "Bot"}})
            return 201, self.comments[-1]
        if method == "PATCH" and (match := re.fullmatch(r"/repos/o/r/issues/comments/(\d+)", path)):
            comment = next(c for c in self.comments if c["id"] == int(match.group(1)))
            comment["body"] = body["body"]
            return 200, comment
        if method == "GET" and re.fullmatch(r"/repos/o/r/pulls/\d+", path):
            return (200, self.diff.encode()) if "diff" in accept else (200, self.pull)
        if method == "GET" and path.removeprefix("/repos/o/r/tarball/") in self.commits:
            return 200, self.tree
        return 404, {"message": "Not Found"}
