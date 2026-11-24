"""The agent runner: Claude, in short separate phases, driving one sandbox through a fixed set of tools.

Runs outside the sandbox. The Anthropic key and the E2B key stay in this process; the sandbox, which holds
untrusted code, never sees either. Claude writes files and runs commands; `pledge.check`, running in the
sandbox, decides whether a phase's output is accepted.
"""

from __future__ import annotations

import json
import os
import posixpath
import time
from collections.abc import Callable
from dataclasses import asdict, dataclass, field
from pathlib import Path

from pledge import prompts
from pledge.scan import APP, PACKAGE, RUNS

MODEL = "claude-opus-5-5"
KEY_FILE = Path.home() / ".config/workz/anthropic.env"
MAX_TOKENS = 16000
OUTPUT_CHARS = 6000  # of a command's output, kept from the end
FILE_CHARS = 60000
MAX_COMMAND_SECONDS = 900  # a first build of a compiled app
MAX_NUDGES = 2
CHECK = f"cd /work && PYTHONPATH={PACKAGE} python3 -m pledge.check"


class AgentError(RuntimeError):
    """The phase could not finish: a budget ran out, the model declined, or the API failed."""


@dataclass(frozen=True)
class Budget:
    tokens: int  # input (cached or not) plus output, summed over every request of the phase
    seconds: int
    commands: int


@dataclass
class Usage:
    requests: int = 0
    input_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    output_tokens: int = 0
    commands: int = 0
    seconds: float = 0.0
    rejected_finishes: int = 0

    @property
    def tokens(self) -> int:
        return self.input_tokens + self.cache_read_tokens + self.cache_write_tokens + self.output_tokens


@dataclass(frozen=True)
class Phase:
    name: str
    system: str
    task: str
    finish_tool: dict
    verify: Callable[[object], dict]  # sandbox -> {"problems": [...], ...}; code decides acceptance
    budget: Budget
    effort: str


@dataclass
class PhaseResult:
    name: str
    result: dict  # what the agent reported in `finish`
    check: dict  # what the deterministic check reported when it accepted
    usage: Usage = field(default_factory=Usage)

    def to_json(self) -> dict:
        return {"phase": self.name, "model": MODEL, "result": self.result, "check": self.check, "usage": asdict(self.usage) | {"tokens": self.usage.tokens}}


def load_key() -> None:
    if os.environ.get("ANTHROPIC_API_KEY"):
        return
    try:
        lines = KEY_FILE.read_text().splitlines()
    except OSError:
        raise AgentError(f"ANTHROPIC_API_KEY is not set and {KEY_FILE} is not readable") from None
    for line in lines:
        name, _, value = line.partition("=")
        if name == "ANTHROPIC_API_KEY" and value.strip():
            os.environ["ANTHROPIC_API_KEY"] = value.strip()
            return
    raise AgentError(f"{KEY_FILE} has no ANTHROPIC_API_KEY")


def _resolve(path: str) -> str:
    """A sandbox path under /work/app. The agent's writes stay inside the repository."""
    full = posixpath.normpath(posixpath.join(APP, path))
    if full != APP and not full.startswith(APP + "/"):
        raise ValueError(f"{path} is outside {APP}")
    return full


def _run_command(sandbox, command: str, timeout_seconds: int) -> str:
    from e2b import CommandExitException, TimeoutException

    timeout = max(1, min(int(timeout_seconds), MAX_COMMAND_SECONDS))
    try:
        done = sandbox.commands.run(f"cd {APP} && {command}", timeout=timeout, user="root")
        code, output = done.exit_code, done.stdout + done.stderr
    except CommandExitException as exc:
        code, output = exc.exit_code, exc.stdout + exc.stderr
    except TimeoutException:
        return f"stopped after {timeout}s without finishing"
    cut = f"[first {len(output) - OUTPUT_CHARS} characters cut]\n" if len(output) > OUTPUT_CHARS else ""
    return f"exit code {code}\n{cut}{output[-OUTPUT_CHARS:]}"


def _execute(sandbox, name: str, args: dict, usage: Usage) -> tuple[str, bool]:
    """Run one work tool; returns (text for the model, is_error). Failures are reported, never raised."""
    try:
        if name == "run_command":
            usage.commands += 1
            return _run_command(sandbox, args["command"], args["timeout_seconds"]), False
        if name == "read_file":
            text = sandbox.files.read(_resolve(args["path"]), user="root")
            return (text[:FILE_CHARS] + f"\n[cut: the file has {len(text)} characters]" if len(text) > FILE_CHARS else text), False
        if name == "write_file":
            path = _resolve(args["path"])
            sandbox.files.write(path, args["content"], user="root")
            return f"wrote {path}", False
        return f"unknown tool {name}", True
    except Exception as exc:  # noqa: BLE001 - whatever went wrong in the sandbox, the model should hear it and adapt
        return f"{type(exc).__name__}: {str(exc)[:500]}", True


def run_phase(client, sandbox, phase: Phase, log: Callable[[str], None] = lambda _: None) -> PhaseResult:
    """Drive one phase until `finish` is accepted by `phase.verify`, or a budget runs out."""
    import anthropic

    usage, started, nudges = Usage(), time.monotonic(), 0
    tools = [*prompts.WORK_TOOLS, phase.finish_tool]
    messages: list[dict] = [{"role": "user", "content": phase.task}]
    while True:
        usage.seconds = round(time.monotonic() - started, 1)
        for spent, limit, what in ((usage.tokens, phase.budget.tokens, "tokens"), (usage.seconds, phase.budget.seconds, "seconds"), (usage.commands, phase.budget.commands, "commands")):
            if spent >= limit:
                raise AgentError(f"{phase.name}: budget exhausted: {spent} of {limit} {what}; usage {asdict(usage)}")
        try:
            response = client.beta.messages.create(
                model=MODEL,
                max_tokens=MAX_TOKENS,
                system=[{"type": "text", "text": phase.system, "cache_control": {"type": "ephemeral"}}],
                tools=tools,
                messages=messages,
                output_config={"effort": phase.effort},
                cache_control={"type": "ephemeral"},  # the conversation only grows, so each request reuses the last one's prefix
                # A declined request is retried on another model inside the same call instead of ending the phase.
                betas=["server-side-fallback-2026-07-01"],
                fallbacks="default",
            )
        except anthropic.RateLimitError as exc:
            raise AgentError(f"{phase.name}: rate limited by the Anthropic API: {exc.message}") from None
        except anthropic.APIStatusError as exc:
            raise AgentError(f"{phase.name}: Anthropic API error {exc.status_code}: {exc.message}") from None
        except anthropic.APIConnectionError as exc:
            raise AgentError(f"{phase.name}: could not reach the Anthropic API: {exc}") from None

        usage.requests += 1
        usage.input_tokens += response.usage.input_tokens
        usage.output_tokens += response.usage.output_tokens
        usage.cache_read_tokens += response.usage.cache_read_input_tokens or 0
        usage.cache_write_tokens += response.usage.cache_creation_input_tokens or 0
        if response.stop_reason == "refusal":
            raise AgentError(f"{phase.name}: the model declined to continue")
        if response.stop_reason == "max_tokens":
            raise AgentError(f"{phase.name}: a reply was cut off at {MAX_TOKENS} tokens")

        messages.append({"role": "assistant", "content": response.content})
        calls = [block for block in response.content if block.type == "tool_use"]
        if not calls:
            nudges += 1
            if nudges > MAX_NUDGES:
                raise AgentError(f"{phase.name}: the model stopped without calling finish")
            messages.append({"role": "user", "content": "The phase ends only when you call `finish`. Continue the work, or call it now."})
            continue

        results = []
        for call in calls:
            if call.name == "finish":
                log(f"{phase.name}: finish called, checking")
                check = phase.verify(sandbox)
                if not check["problems"]:
                    usage.seconds = round(time.monotonic() - started, 1)
                    return PhaseResult(phase.name, dict(call.input), check, usage)
                usage.rejected_finishes += 1
                log(f"{phase.name}: not accepted: {check['problems'][0][:160]}")
                text, is_error = "Not accepted. Problems found by Pledge's checks:\n- " + "\n- ".join(check["problems"]), True
            else:
                log(f"{phase.name}: {call.name} {str(call.input.get('command') or call.input.get('path'))[:110]}")
                text, is_error = _execute(sandbox, call.name, call.input, usage)
            results.append({"type": "tool_result", "tool_use_id": call.id, "content": text, "is_error": is_error})
        messages.append({"role": "user", "content": results})  # every result of the turn in one message


def _check(sandbox, arguments: str, timeout: int = 600) -> dict:
    from pledge.scan import _sh

    try:
        return json.loads(_sh(sandbox, f"{CHECK} {arguments}", timeout=timeout).strip().splitlines()[-1])
    except (RuntimeError, ValueError, IndexError) as exc:
        return {"problems": [f"Pledge's check itself failed to run: {str(exc)[:600]}"]}


def boot_phase() -> Phase:
    return Phase(
        name="boot",
        system=prompts.BOOT,
        task="The repository is at /work/app. Discover what it is, get it booting from pledge.boot.json, and call finish.",
        finish_tool=prompts.BOOT_FINISH,
        verify=lambda sandbox: _check(sandbox, "boot app"),
        budget=Budget(tokens=8_000_000, seconds=2100, commands=150),
        effort="medium",
    )


def author_phase(discovered: dict, recipe: str) -> Phase:
    task = (
        "What the previous phase learned about the application:\n\n```json\n" + json.dumps(discovered, indent=2)
        + "\n```\n\nThe boot recipe it wrote, /work/app/pledge.boot.json:\n\n```json\n" + recipe
        + "\n```\n\nThe application is running. Write the caller inventory first, then the scenarios, pledges and faults files, then call finish."
    )
    return Phase(
        name="author",
        system=prompts.author_system(),
        task=task,
        finish_tool=prompts.AUTHOR_FINISH,
        verify=lambda sandbox: _check(sandbox, f"author app {RUNS}/baseline"),
        budget=Budget(tokens=8_000_000, seconds=1500, commands=120),
        effort="high",
    )
