"""Shared by the Phase 0 spikes. The E2B key is read from outside the repository."""
import os
import time
from contextlib import contextmanager
from pathlib import Path

KEY_FILE = Path.home() / ".config/workz/e2b.env"

if "E2B_API_KEY" not in os.environ:
    for line in KEY_FILE.read_text().splitlines():
        name, _, value = line.partition("=")
        if name == "E2B_API_KEY":
            os.environ["E2B_API_KEY"] = value.strip()


def sh(sandbox, command, timeout=600, user="root", check=False):
    """Run a shell command; return (exit_code, combined output). Never raises on a non-zero exit unless `check`."""
    from e2b import CommandExitException

    started = time.monotonic()
    try:
        result = sandbox.commands.run(command, timeout=timeout, user=user)
        code, out = result.exit_code, (result.stdout + result.stderr)
    except CommandExitException as exc:
        code, out = exc.exit_code, (exc.stdout + exc.stderr)
    took = time.monotonic() - started
    if check and code:
        raise RuntimeError(f"`{command[:80]}` exited {code}: {out[-600:]}")
    return code, out.strip(), round(took, 2)


@contextmanager
def timed(label, results):
    started = time.monotonic()
    yield
    results[label] = round(time.monotonic() - started, 2)
    print(f"  {label}: {results[label]}s", flush=True)
