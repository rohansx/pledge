"""The GitHub client against a stand-in for api.github.com on a local port: no network, no real token."""

import hashlib
import hmac
import io
import tarfile

import pytest
from fake_github import SHA, FakeGitHub, tarball

from pledge import github
from pledge.github import MARKER, GitHub, GitHubError, verify_signature


@pytest.fixture
def fake():
    server = FakeGitHub()
    yield server
    server.close()


def sign(secret: str, body: bytes) -> str:
    return "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


def test_a_signature_is_accepted_only_for_the_exact_bytes_and_the_right_secret():
    body = b'{"action":"opened"}'

    assert verify_signature("s3cret", body, sign("s3cret", body))
    for header in (sign("other", body), sign("s3cret", body + b" "), None, "", "sha256=", sign("s3cret", body).replace("sha256=", "sha1="), sign("s3cret", body)[:-1], "sha256=é"):
        assert not verify_signature("s3cret", body, header), header
    assert not verify_signature("", body, sign("", body))  # no secret configured never means "anything goes"


def test_the_app_token_is_rs256_issued_by_the_app_and_short_lived():
    jwt = pytest.importorskip("jwt", reason="PyJWT[crypto] comes with the api extra")
    rsa = pytest.importorskip("cryptography.hazmat.primitives.asymmetric.rsa")
    from cryptography.hazmat.primitives import serialization

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.TraditionalOpenSSL, serialization.NoEncryption()).decode()

    token = github.app_jwt("12345", pem, now=1_800_000_000)

    assert jwt.get_unverified_header(token)["alg"] == "RS256"
    claims = jwt.decode(token, key.public_key(), algorithms=["RS256"], options={"verify_exp": False, "verify_iat": False})
    assert claims == {"iss": "12345", "iat": 1_800_000_000 - 60, "exp": 1_800_000_000 + 540}  # GitHub allows at most ten minutes


def test_an_installation_token_is_asked_for_with_the_app_token_and_for_one_repository(fake):
    token = GitHub("app.jwt", fake.url).installation_token(7, repository_id=99)

    assert token == "installation-token"
    assert fake.calls == [{"method": "POST", "path": "/app/installations/7/access_tokens", "auth": "Bearer app.jwt", "accept": "application/vnd.github+json", "body": {"repository_ids": [99]}}]


def test_a_check_run_starts_in_progress_and_is_completed_with_a_conclusion(fake):
    client = GitHub("t", fake.url)

    check_id = client.create_check_run("o/r", SHA)
    assert fake.checks[check_id] == {"name": "Pledge", "head_sha": SHA, "status": "in_progress"}

    client.complete_check_run("o/r", check_id, "failure", "An approved pledge broke", "x" * 70000)
    done = fake.checks[check_id]
    assert (done["status"], done["conclusion"], done["output"]["title"]) == ("completed", "failure", "An approved pledge broke")
    assert len(done["output"]["summary"]) == github.MAX_OUTPUT_CHARS  # GitHub refuses more than 65535


def test_the_comment_is_written_once_and_edited_after_that(fake):
    client = GitHub("t", fake.url)
    fake.comments.append({"id": 1, "body": f"{MARKER} pasted by a person", "user": {"type": "User"}})  # not ours to edit

    first = client.upsert_comment("o/r", 3, "**Pledge: no approved pledge broken**")
    second = client.upsert_comment("o/r", 3, "**Pledge: 1 of 2 pledges broken**")

    assert first == second
    assert [comment["body"] for comment in fake.comments[1:]] == [f"{MARKER}\n**Pledge: 1 of 2 pledges broken**"]
    assert fake.comments[0]["body"].endswith("pasted by a person")
    assert fake.paths("POST") == ["POST /repos/o/r/issues/3/comments"] and fake.paths("PATCH") == [f"PATCH /repos/o/r/issues/comments/{first}"]


def test_the_diff_and_the_description_come_from_the_same_pull_request(fake):
    fake.diff = "diff --git a/app.py b/app.py\n"
    fake.pull = {"title": "T" * 400, "body": None}
    client = GitHub("t", fake.url)

    assert client.diff("o/r", 3) == fake.diff
    assert client.pull_request("o/r", 3) == {"title": "T" * 300, "description": ""}
    assert [call["accept"] for call in fake.calls] == ["application/vnd.github.diff", "application/vnd.github+json"]


def test_a_refusal_names_the_status_and_never_the_token(fake):
    fake.fail["POST /repos/o/r/check-runs"] = 403

    with pytest.raises(GitHubError) as error:
        GitHub("very-secret-token", fake.url).create_check_run("o/r", SHA)

    assert "403" in str(error.value) and "Resource not accessible" in str(error.value)
    assert "very-secret-token" not in str(error.value)


def test_an_unreachable_github_is_an_error_not_a_crash():
    with pytest.raises(GitHubError, match="could not reach GitHub"):
        GitHub("t", "http://127.0.0.1:1").create_check_run("o/r", SHA)


def test_a_repository_name_or_commit_that_could_bend_the_url_is_refused_before_any_call(fake):
    client = GitHub("t", fake.url)

    for repo, sha in (("o/r/../../user", SHA), ("o", SHA), ("o/r?x=1", SHA), ("o/r", "main"), ("o/r", SHA[:-1] + "/")):
        with pytest.raises(GitHubError):
            client.tarball(repo, sha)
    assert fake.calls == []


def test_a_repository_tarball_unpacks_to_its_one_root_directory(fake, tmp_path):
    fake.tree = tarball({"src/app.py": "print(1)\n", ".pledge/pledges/p.json": "{}"})

    root = github.extract_tarball(GitHub("t", fake.url).tarball("o/r", SHA), tmp_path / "tree")

    assert root.name == "o-r-aaaaaaa" and (root / "src" / "app.py").read_text() == "print(1)\n"


def test_a_tarball_entry_that_leaves_the_directory_is_refused(tmp_path):
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
        info = tarfile.TarInfo("root/../../escaped.txt")
        info.size = 1
        archive.addfile(info, io.BytesIO(b"x"))

    with pytest.raises(tarfile.FilterError):
        github.extract_tarball(buffer.getvalue(), tmp_path / "tree")
    assert not (tmp_path.parent / "escaped.txt").exists() and not (tmp_path / "escaped.txt").exists()
