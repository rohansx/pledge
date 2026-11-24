"""What the API accepts. Everything here arrives from outside: the command line, and through it from a sandbox
that ran untrusted code, so every string and list is bounded and unknown fields are refused."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

Result = Literal["kept", "broken", "inconclusive"]
PledgeStatus = Literal["proposed", "proven", "approved", "retired"]
FindingStatus = Literal["open", "fix_proposed", "fixed_unverified", "verified", "reopened"]
Trigger = Literal["first_scan", "pull_request", "manual"]
Phase = Literal["boot", "author", "prove", "run", "done", "failed"]
EventType = Literal["phase_started", "phase_step", "pledge_proposed", "pledge_proven", "seed_finished", "run_finished"]


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class SeedIn(Strict):
    seed: int
    run_id: str = Field(max_length=80)
    status: Literal["pass", "fail", "unknown"]
    expected: Any = None
    actual: Any = None
    failed: int | None = Field(default=None, ge=0)


class StepDetailIn(Strict):
    request: str = Field(max_length=400)
    reply: str = Field(max_length=400)


class StepIn(Strict):
    at: int = Field(ge=0)
    actor: Literal["client", "fault", "check"]
    text: str = Field(max_length=1200)
    detail: StepDetailIn | None = None

class RecordingIn(Strict):
    """One journey that broke the pledge, request by request, as the proxy saw it."""

    seed: int
    journey: str = Field(max_length=200)
    faults_hit: int = Field(ge=0)
    steps: list[StepIn] = Field(max_length=81)


class PledgeIn(Strict):
    id: str = Field(min_length=1, max_length=120, pattern=r"^[A-Za-z0-9][A-Za-z0-9_.-]*$")
    statement: str = Field(max_length=1000)
    status: PledgeStatus
    source: str = Field(max_length=40)
    confidence: str = Field(max_length=20)
    assertion: str = Field(max_length=120)
    result: Result
    kept: int = Field(ge=0)
    broken: int = Field(ge=0)
    unknown: int = Field(ge=0)
    seeds: list[SeedIn] = Field(max_length=256)
    recording: RecordingIn | None = None


class SeedRunIn(Strict):
    seed: int
    run_id: str = Field(max_length=80)
    verdict: Literal["pass", "fail", "inconclusive", "error"]
    faults_injected: int = Field(ge=0)
    journeys: int = Field(ge=0)
    requests: int = Field(default=0, ge=0)
    unexpected_failures: int = Field(default=0, ge=0)
    limitations: list[str] = Field(max_length=20)


class FaultIn(Strict):
    kind: str = Field(max_length=40)
    target: str = Field(max_length=200)
    params: dict[str, Any] = Field(default_factory=dict)


class FaultsIn(Strict):
    name: str = Field(max_length=120)
    description: str = Field(max_length=1000)
    faults: list[FaultIn] = Field(max_length=32)


class SandboxIn(Strict):
    template: str = Field(max_length=120)
    outbound_blocked: bool
    seconds: dict[str, float]


class PhaseIn(Strict):
    phase: str = Field(max_length=40)
    model: str = Field(max_length=80)
    requests: int = Field(ge=0)
    tokens: int = Field(ge=0)
    cache_read_tokens: int = Field(ge=0)
    output_tokens: int = Field(ge=0)
    commands: int = Field(ge=0)
    seconds: float = Field(ge=0)
    rejected_finishes: int = Field(ge=0)


class AuthoringIn(Strict):
    seconds: float = Field(ge=0)
    phases: list[PhaseIn] = Field(max_length=8)
    summary: str = Field(max_length=6000)
    open_questions: list[str] = Field(max_length=20)


class RunResultIn(Strict):
    """A finished scan: per-pledge results over its seeds, the fault plan, and how it was run."""

    schema_version: Literal[1]
    scenario: str = Field(min_length=1, max_length=120, pattern=r"^[A-Za-z0-9][A-Za-z0-9_.-]*$")
    faults: FaultsIn | None
    env: dict[str, str]
    pledges: list[PledgeIn] = Field(max_length=200)
    runs: list[SeedRunIn] = Field(min_length=1, max_length=256)
    sandbox: SandboxIn | None
    authoring: AuthoringIn | None


class RunStartIn(Strict):
    """Registers a run the command line is about to make. The repo is created if this is its first run."""

    trigger: Trigger = "manual"
    phase: Phase = "run"
    scenario: str | None = Field(default=None, max_length=120)
    commit: str | None = Field(default=None, max_length=64)
    pull_request: int | None = Field(default=None, ge=1)
    seeds: int | None = Field(default=None, ge=1, le=256)


class EventIn(Strict):
    type: EventType
    payload: dict[str, Any] = Field(default_factory=dict)


class FindingPatch(Strict):
    status: Literal["open", "fix_proposed", "fixed_unverified"]  # "verified" and "reopened" are set by reruns only


class PledgePatch(Strict):
    action: Literal["approve", "reject", "retire"]
    override: bool = False  # required to approve a pledge that no planted bug has proven
    note: str = Field(default="", max_length=1000)
