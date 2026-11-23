"""The agent loop with a scripted model and a fake sandbox: no network, no keys."""

from types import SimpleNamespace

import pytest

from pledge import agent, prompts


def block(name, **args):
    return SimpleNamespace(type="tool_use", id=f"id-{name}-{len(args)}", name=name, input=args)


def reply(*blocks, stop_reason="tool_use", tokens=100):
    usage = SimpleNamespace(input_tokens=tokens, output_tokens=10, cache_read_input_tokens=5, cache_creation_input_tokens=None)
    return SimpleNamespace(content=list(blocks), stop_reason=stop_reason, usage=usage)


class ScriptedClient:
    """Stands in for anthropic.Anthropic(): returns the scripted replies in order and keeps what it was sent."""

    def __init__(self, *replies):
        self.replies, self.requests = list(replies), []
        self.beta = SimpleNamespace(messages=SimpleNamespace(create=self._create))

    def _create(self, **request):
        self.requests.append({**request, "messages": list(request["messages"])})
        return self.replies.pop(0)


class FakeSandbox:
    def __init__(self):
        self.written, self.commands = {}, []
        self.files = SimpleNamespace(read=lambda path, user=None: self.written[path], write=self._write)
        self.commands_api = SimpleNamespace(run=self._run)

    @property
    def commands(self):  # the e2b attribute name, which the loop calls as sandbox.commands.run(...)
        return self.commands_api

    @commands.setter
    def commands(self, value):
        self.ran = value

    def _write(self, path, content, user=None):
        self.written[path] = content

    def _run(self, command, timeout=None, user=None):
        self.ran.append(command)
        return SimpleNamespace(exit_code=0, stdout="ok\n", stderr="")


def phase(verify, budget=agent.Budget(tokens=10_000, seconds=60, commands=5)):
    return agent.Phase(name="boot", system="system", task="go", finish_tool=prompts.BOOT_FINISH, verify=verify, budget=budget, effort="medium")


def test_a_phase_ends_when_the_check_accepts_finish_and_reports_what_it_cost():
    sandbox = FakeSandbox()
    client = ScriptedClient(
        reply(block("write_file", path="pledge.boot.json", content="{}"), block("run_command", command="pledge boot .", timeout_seconds=60)),
        reply(block("finish", summary="a shop")),
    )

    result = agent.run_phase(client, sandbox, phase(lambda _: {"problems": [], "target": "http://t"}))

    assert result.result == {"summary": "a shop"}
    assert result.check == {"problems": [], "target": "http://t"}
    assert sandbox.written == {"/work/app/pledge.boot.json": "{}"}
    assert sandbox.ran == ["cd /work/app && pledge boot ."]
    assert (result.usage.requests, result.usage.commands, result.usage.input_tokens, result.usage.cache_read_tokens) == (2, 1, 200, 10)


def test_every_tool_result_of_a_turn_goes_back_in_one_user_message():
    client = ScriptedClient(
        reply(block("write_file", path="a", content="1"), block("write_file", path="b", content="2")),
        reply(block("finish", summary="x")),
    )

    agent.run_phase(client, FakeSandbox(), phase(lambda _: {"problems": []}))

    results = client.requests[1]["messages"][-1]
    assert results["role"] == "user"
    assert [item["type"] for item in results["content"]] == ["tool_result", "tool_result"]


def test_a_rejected_finish_returns_the_problems_and_the_phase_continues():
    verdicts = iter([{"problems": ["`pledge boot` failed: app exited"]}, {"problems": []}])
    client = ScriptedClient(reply(block("finish", summary="x")), reply(block("finish", summary="y")))

    result = agent.run_phase(client, FakeSandbox(), phase(lambda _: next(verdicts)))

    rejected = client.requests[1]["messages"][-1]["content"][0]
    assert rejected["is_error"] is True and "`pledge boot` failed: app exited" in rejected["content"]
    assert result.result == {"summary": "y"}
    assert result.usage.rejected_finishes == 1


def test_the_model_cannot_end_a_phase_by_just_stopping():
    client = ScriptedClient(*[reply(SimpleNamespace(type="text", text="done!"), stop_reason="end_turn")] * 3)

    with pytest.raises(agent.AgentError, match="stopped without calling finish"):
        agent.run_phase(client, FakeSandbox(), phase(lambda _: {"problems": []}))

    assert "call `finish`" in client.requests[1]["messages"][-1]["content"]


@pytest.mark.parametrize(
    ("budget", "what"),
    [(agent.Budget(tokens=150, seconds=60, commands=5), "tokens"), (agent.Budget(tokens=10_000, seconds=60, commands=1), "commands")],
)
def test_an_exhausted_budget_ends_the_phase(budget, what):
    command = reply(block("run_command", command="ls", timeout_seconds=5))
    client = ScriptedClient(command, command, command)

    with pytest.raises(agent.AgentError, match=f"budget exhausted: .* {what}"):
        agent.run_phase(client, FakeSandbox(), phase(lambda _: {"problems": []}, budget))


@pytest.mark.parametrize("stop_reason", ["refusal", "max_tokens"])
def test_a_declined_or_truncated_reply_ends_the_phase(stop_reason):
    client = ScriptedClient(reply(stop_reason=stop_reason))

    with pytest.raises(agent.AgentError):
        agent.run_phase(client, FakeSandbox(), phase(lambda _: {"problems": []}))


@pytest.mark.parametrize("path", ["../../etc/passwd", "/etc/passwd", "/work/application/x", "a/../../b"])
def test_writes_outside_the_repository_are_refused_and_reported_to_the_model(path):
    sandbox = FakeSandbox()
    client = ScriptedClient(reply(block("write_file", path=path, content="x")), reply(block("finish", summary="x")))

    agent.run_phase(client, sandbox, phase(lambda _: {"problems": []}))

    refused = client.requests[1]["messages"][-1]["content"][0]
    assert refused["is_error"] is True and "outside /work/app" in refused["content"]
    assert sandbox.written == {}


def test_paths_inside_the_repository_resolve_under_it():
    assert agent._resolve("pledge.boot.json") == "/work/app/pledge.boot.json"
    assert agent._resolve("/work/app/.pledge/x.json") == "/work/app/.pledge/x.json"
    assert agent._resolve("a/./b/../c") == "/work/app/a/c"


def test_every_request_asks_for_fallbacks_caching_and_the_phase_effort():
    client = ScriptedClient(reply(block("finish", summary="x")))

    agent.run_phase(client, FakeSandbox(), phase(lambda _: {"problems": []}))

    request = client.requests[0]
    assert request["model"] == "claude-opus-5-5"
    assert request["fallbacks"] == "default" and request["betas"] == ["server-side-fallback-2026-07-01"]
    assert request["output_config"] == {"effort": "medium"}
    assert request["cache_control"] == {"type": "ephemeral"}
    assert [tool["name"] for tool in request["tools"]] == ["run_command", "read_file", "write_file", "finish"]
    assert "thinking" not in request and "tool_choice" not in request  # both are rejected or pointless on this model


def test_tool_schemas_are_strict():
    for tool in [*prompts.WORK_TOOLS, prompts.BOOT_FINISH, prompts.AUTHOR_FINISH]:
        assert tool["strict"] is True
        assert tool["input_schema"]["additionalProperties"] is False
        assert set(tool["input_schema"]["required"]) == set(tool["input_schema"]["properties"])
