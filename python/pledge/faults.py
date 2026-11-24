"""Fault plans as the proxy understands them: which requests a fault applies to, and whether it fires.

The plan's outer shape (schema_version, seed, faults of kind/target/params) is LiteTraffic's, which records it
with each run. The `params` of each kind are defined here, because the proxy is what applies them.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from fnmatch import fnmatchcase

# The kinds this proxy applies. LiteTraffic, which records the plan, names two of them differently; both
# spellings are accepted and `engine_kind` gives the one the engine validates.
# ponytail: no `reorder` yet. It needs two different requests held and swapped; add it with its own params.
SUPPORTED_KINDS = ("retry", "duplicate", "race", "delay", "restart")
ALIASES = {"duplicate_delivery": "duplicate", "same_instant": "race"}
DEFAULT_RETRY_STATUS = 504
MAX_HOLD_MS = 60_000  # longer than any client waits; a larger number is a typo, not a test
DUPLICATE_MODES = ("after", "concurrent")


class PlanError(ValueError):
    """The plan is not one this proxy can apply."""


def engine_kind(kind: str) -> str:
    """The name LiteTraffic knows a kind by."""
    return next((engine for engine, ours in ALIASES.items() if ours == kind), kind)


@dataclass(frozen=True)
class Fault:
    """One fault of the plan. `target` is "ROUTE METHOD PATH", where PATH may use shell-style wildcards:
    "app POST /payments". `rate` is the share of matching new requests the fault fires on.

    retry      the request reaches the upstream, then the reply is replaced by `status`, so the caller sends it again
    duplicate  the caller gets the real reply, and the proxy delivers the same request a second time: `delay_ms`
               after the first reply (`concurrent` false) or after the first was sent (`concurrent` true)
    race       the request is sent twice at the same instant; the caller gets whichever reply comes first
    delay      the reply is held for `ms`
    restart    `after_ms` after the request was sent, `service` is killed and started again; at most `limit` times a run
    """

    index: int
    kind: str
    route: str
    method: str
    path: str
    rate: float
    status: int = DEFAULT_RETRY_STATUS
    ms: int = 0
    delay_ms: int = 0
    concurrent: bool = False
    service: str = ""
    after_ms: int = 0
    limit: int = 1

    def matches(self, route: str, method: str, path: str) -> bool:
        return route == self.route and method == self.method and fnmatchcase(path, self.path)


@dataclass(frozen=True)
class Plan:
    seed: int
    faults: tuple[Fault, ...]

    def matching(self, route: str, method: str, path: str) -> tuple[Fault, ...]:
        """Every fault whose target covers this request, in plan order. Each keeps its own count of matching
        requests, so adding a fault to a plan does not move where the others fire."""
        return tuple(fault for fault in self.faults if fault.matches(route, method, path))

    def fires(self, fault: Fault, ordinal: int) -> bool:
        """Whether `fault` fires on the `ordinal`-th new request it matches (0-based).

        The answer depends only on the seed, the fault and the ordinal, so the same seed injects the same
        pattern on every run. Request content cannot be used: journey keys carry the run id."""
        return _unit(self.seed, fault.index, ordinal) < fault.rate


EMPTY_PLAN = Plan(seed=0, faults=())


def _unit(seed: int, index: int, ordinal: int) -> float:
    digest = hashlib.sha256(f"{seed}:{index}:{ordinal}".encode()).digest()
    return int.from_bytes(digest[:8], "big") / 2**64


def fingerprint(route: str, method: str, path_qs: str, body: bytes) -> str:
    """Identifies a logical request: a retry of the same request has the same fingerprint."""
    return hashlib.sha256(b"\0".join([route.encode(), method.encode(), path_qs.encode(), body])).hexdigest()


def parse_plan(data: object) -> Plan:
    """Validate an untrusted plan document. Raises PlanError naming the first problem."""
    if not isinstance(data, dict) or data.get("schema_version") != 1:
        raise PlanError("plan must be an object with schema_version 1")
    seed, faults = data.get("seed"), data.get("faults")
    if isinstance(seed, bool) or not isinstance(seed, int):
        raise PlanError("plan seed must be an integer")
    if not isinstance(faults, list):
        raise PlanError("plan faults must be a list")
    return Plan(seed=seed, faults=tuple(_parse_fault(index, fault) for index, fault in enumerate(faults)))


def _number(where: str, params: dict, name: str, default: int, low: int = 0, high: int = MAX_HOLD_MS) -> int:
    value = params.get(name, default)
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        raise PlanError(f"{where}: {name} must be an integer from {low} to {high}")
    return value


# What `params` each kind takes, besides `rate`.
PARAMS = {"retry": {"status"}, "duplicate": {"delay_ms", "mode"}, "race": set(), "delay": {"ms"}, "restart": {"service", "after_ms", "max"}}


def _parse_fault(index: int, fault: object) -> Fault:
    where = f"faults[{index}]"
    if not isinstance(fault, dict):
        raise PlanError(f"{where} must be an object")
    kind = fault.get("kind")
    kind = ALIASES.get(kind, kind) if isinstance(kind, str) else kind
    if kind not in SUPPORTED_KINDS:
        raise PlanError(f"{where}: this proxy cannot apply kind {fault.get('kind')!r}; supported: {', '.join(SUPPORTED_KINDS)}")
    target = fault.get("target")
    parts = target.split(" ") if isinstance(target, str) else []
    if len(parts) != 3 or not parts[2].startswith("/"):
        raise PlanError(f"{where}: target must be 'ROUTE METHOD /path', got {target!r}")
    params = fault.get("params") or {}
    allowed = {"rate", *PARAMS[kind]}
    if not isinstance(params, dict) or set(params) - allowed:
        raise PlanError(f"{where}: {kind} params may only be {', '.join(sorted(allowed))}")
    rate = params.get("rate", 1.0)
    if isinstance(rate, bool) or not isinstance(rate, int | float) or not 0 <= rate <= 1:
        raise PlanError(f"{where}: rate must be a number from 0 to 1")
    extra: dict = {}
    if kind == "retry":
        extra["status"] = params.get("status", DEFAULT_RETRY_STATUS)
        if isinstance(extra["status"], bool) or not isinstance(extra["status"], int) or not 500 <= extra["status"] <= 599:
            raise PlanError(f"{where}: status must be a 5xx integer")
    elif kind == "duplicate":
        mode = params.get("mode", "after")
        if mode not in DUPLICATE_MODES:
            raise PlanError(f"{where}: mode must be one of {', '.join(DUPLICATE_MODES)}")
        extra = {"delay_ms": _number(where, params, "delay_ms", 0), "concurrent": mode == "concurrent"}
    elif kind == "delay":
        if "ms" not in params:
            raise PlanError(f"{where}: delay needs ms, how long the reply is held")
        extra["ms"] = _number(where, params, "ms", 0, low=1)
    elif kind == "restart":
        service = params.get("service")
        if not isinstance(service, str) or not service:
            raise PlanError(f"{where}: restart needs service, the name of a service in the boot recipe")
        extra = {"service": service, "after_ms": _number(where, params, "after_ms", 0), "limit": _number(where, params, "max", 1, low=1, high=100)}
    return Fault(index=index, kind=kind, route=parts[0], method=parts[1].upper(), path=parts[2], rate=float(rate), **extra)
