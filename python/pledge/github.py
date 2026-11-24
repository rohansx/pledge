"""The GitHub App's side of a pull request: verify a webhook, get a short-lived token for one installation,
report a check run, keep one comment up to date, and read the pull request's diff and tree.

Standard library only, except for signing the app's token (RS256, from PyJWT). Nothing here logs: a webhook
body, a token and a private key never reach a log line or an error message.
"""

from __future__ import annotations

import hashlib
import hmac
import io
import json
import re
import tarfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

API = "https://api.github.com"
MARKER = "<!-- pledge:report -->"  # hidden in the comment body; how the previous comment is found again
REPO = re.compile(r"^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$")
SHA = re.compile(r"^[0-9a-f]{40}$|^[0-9a-f]{64}$")
MAX_DIFF_BYTES = 2 * 1024 * 1024
MAX_TARBALL_BYTES = 200 * 1024 * 1024
MAX_TREE_BYTES = 1024 * 1024 * 1024  # unpacked: a small archive can expand to fill the disk
MAX_OUTPUT_CHARS = 60000  # GitHub refuses a check summary or a comment over 65535
COMMENT_PAGES = 10


class GitHubError(RuntimeError):
    """GitHub refused a call or could not be reached. The message carries the status, never a token."""


def verify_signature(secret: str, body: bytes, header: str | None) -> bool:
    """Whether `header`, the X-Hub-Signature-256 of a delivery, is the HMAC of exactly these bytes."""
    if not secret or not header or not header.startswith("sha256="):
        return False
    expected = "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected.encode(), header.encode())  # bytes: a header may hold non-ASCII


def app_jwt(app_id: str, private_key: str, now: float | None = None) -> str:
    """The app's own token, good for ten minutes and only for asking for installation tokens."""
    import jwt  # PyJWT[crypto]; imported here so that verifying a webhook needs nothing but the standard library

    issued = int(time.time() if now is None else now)
    # Issued a minute ago: GitHub refuses a token from the future, and clocks drift.
    return jwt.encode({"iat": issued - 60, "exp": issued + 540, "iss": str(app_id)}, private_key, algorithm="RS256")


def _checked(repo: str, sha: str | None = None) -> str:
    if not REPO.match(repo) or (sha is not None and not SHA.match(sha)):
        raise GitHubError("not a repository name or commit this client will put in a URL")
    return repo


class GitHub:
    """Calls made with one token. `base_url` is GitHub's API, or a stand-in for it in tests."""

    def __init__(self, token: str, base_url: str = API) -> None:
        self._token, self._base = token, base_url.rstrip("/")

    def _open(self, method: str, path: str, body: dict | None, accept: str, limit: int) -> bytes:
        request = urllib.request.Request(
            self._base + path, data=None if body is None else json.dumps(body).encode(), method=method,
            headers={"authorization": f"Bearer {self._token}", "accept": accept, "x-github-api-version": "2022-11-28", "user-agent": "pledge", "content-type": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                data = response.read(limit + 1)
        except urllib.error.HTTPError as error:
            try:
                detail = str(json.load(error).get("message", ""))[:200]
            except (ValueError, AttributeError):
                detail = ""
            raise GitHubError(f"GitHub answered {error.code} to {method} {path.split('?')[0]}: {detail or error.reason}") from None
        except (urllib.error.URLError, OSError) as error:
            raise GitHubError(f"could not reach GitHub for {method} {path.split('?')[0]}: {getattr(error, 'reason', error)}") from None
        if len(data) > limit:
            raise GitHubError(f"the reply to {method} {path.split('?')[0]} is over {limit} bytes")
        return data

    def _json(self, method: str, path: str, body: dict | None = None) -> dict | list:
        return json.loads(self._open(method, path, body, "application/vnd.github+json", MAX_DIFF_BYTES) or b"null")

    def installation_token(self, installation_id: int, repository_id: int | None = None) -> str:
        """Called with the app's token. The token returned lasts an hour and, given a repository, reaches only it."""
        body = {"repository_ids": [repository_id]} if repository_id else None
        return self._json("POST", f"/app/installations/{int(installation_id)}/access_tokens", body)["token"]

    def create_check_run(self, repo: str, head_sha: str, name: str = "Pledge") -> int:
        return self._json("POST", f"/repos/{_checked(repo, head_sha)}/check-runs", {"name": name, "head_sha": head_sha, "status": "in_progress"})["id"]

    def complete_check_run(self, repo: str, check_run_id: int, conclusion: str, title: str, summary: str) -> None:
        body = {"status": "completed", "conclusion": conclusion, "output": {"title": title[:200], "summary": summary[:MAX_OUTPUT_CHARS]}}
        self._json("PATCH", f"/repos/{_checked(repo)}/check-runs/{int(check_run_id)}", body)

    def upsert_comment(self, repo: str, pull_request: int, markdown: str) -> int:
        """Keep ONE Pledge comment on the pull request: edit the one carrying the marker, or write it."""
        body = {"body": f"{MARKER}\n{markdown}"[:MAX_OUTPUT_CHARS]}
        comments = f"/repos/{_checked(repo)}/issues"
        # ponytail: reads at most 1000 comments. Past that a second comment appears; store the comment id on the repo then.
        for page in range(1, COMMENT_PAGES + 1):
            batch = self._json("GET", f"{comments}/{int(pull_request)}/comments?per_page=100&page={page}")
            for comment in batch:
                # Only a bot's comment: anyone can paste the marker into their own, and editing that is refused.
                if MARKER in (comment.get("body") or "") and (comment.get("user") or {}).get("type") == "Bot":
                    return self._json("PATCH", f"{comments}/comments/{int(comment['id'])}", body)["id"]
            if len(batch) < 100:
                break
        return self._json("POST", f"{comments}/{int(pull_request)}/comments", body)["id"]

    def pull_request(self, repo: str, number: int) -> dict:
        """The title and description, as written by the pull request's author: data, never instructions."""
        pull = self._json("GET", f"/repos/{_checked(repo)}/pulls/{int(number)}")
        return {"title": str(pull.get("title") or "")[:300], "description": str(pull.get("body") or "")[:20000]}

    def diff(self, repo: str, number: int) -> str:
        return self._open("GET", f"/repos/{_checked(repo)}/pulls/{int(number)}", None, "application/vnd.github.diff", MAX_DIFF_BYTES).decode("utf-8", "replace")

    def tarball(self, repo: str, sha: str) -> bytes:
        return self._open("GET", f"/repos/{_checked(repo, sha)}/tarball/{sha}", None, "application/vnd.github+json", MAX_TARBALL_BYTES)


def extract_tarball(data: bytes, directory: Path) -> Path:
    """Unpack a repository tarball and return the tree's root, the one directory GitHub wraps it in."""
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
        if sum(member.size for member in archive.getmembers()) > MAX_TREE_BYTES:
            raise GitHubError(f"the repository unpacks to over {MAX_TREE_BYTES} bytes")
        # The tree is whatever a pull request's author committed: the "data" filter refuses paths that leave
        # the directory, links that point outside it, and devices.
        archive.extractall(directory, filter="data")
    roots = [path for path in directory.iterdir() if path.is_dir()]
    if len(roots) != 1:
        raise GitHubError("the repository tarball does not hold exactly one directory")
    return roots[0]
