"""Fault plans as the proxy understands them: which requests a fault applies to, and whether it fires.

The plan's outer shape (schema_version, seed, faults of kind/target/params) is LiteTraffic's, which records it
with each run. The `params` of each kind are defined here, because the proxy is what applies them.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from fnmatch import fnmatchcase

# ponytail: only `retry` is applied so far. The other kinds LiteTraffic accepts (duplicate_delivery, same_instant,
# reorder, delay, restart) are refused by name rather than silently ignored; add each with its own params.
SUPPORTED_KINDS = ("retry",)
DEFAULT_RETRY_STATUS = 504


class PlanError(ValueError):
    """The plan is not one this proxy can apply."""


@dataclass(frozen=True)
class RetryFault:
    """Let the request reach the upstream, then lose the reply, so that the caller sends the request again.

    `target` is "ROUTE METHOD PATH", where PATH may use shell-style wildcards: "app POST /payments".
    `rate` is the share of matching requests whose first attempt loses its reply."""

    index: int
    route: str
    method: str
    path: str
    rate: float
    status: int

    def matches(self, route: str, method: str, path: str) -> bool:
        return route == self.route and method == self.method and fnmatchcase(path, self.path)


@dataclass(frozen=True)
class Plan:
    seed: int
    faults: tuple[RetryFault, ...]

    def matching(self, route: str, method: str, path: str) -> RetryFault | None:
        """The first fault whose target covers this request."""
        return next((fault for fault in self.faults if fault.matches(route, method, path)), None)

    def fires(self, fault: RetryFault, ordinal: int) -> bool:
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


def _parse_fault(index: int, fault: object) -> RetryFault:
    where = f"faults[{index}]"
    if not isinstance(fault, dict):
        raise PlanError(f"{where} must be an object")
    kind = fault.get("kind")
    if kind not in SUPPORTED_KINDS:
        raise PlanError(f"{where}: this proxy cannot apply kind {kind!r}; supported: {', '.join(SUPPORTED_KINDS)}")
    target = fault.get("target")
    parts = target.split(" ") if isinstance(target, str) else []
    if len(parts) != 3 or not parts[2].startswith("/"):
        raise PlanError(f"{where}: target must be 'ROUTE METHOD /path', got {target!r}")
    params = fault.get("params") or {}
    if not isinstance(params, dict) or set(params) - {"rate", "status"}:
        raise PlanError(f"{where}: retry params may only be rate and status")
    rate, status = params.get("rate", 1.0), params.get("status", DEFAULT_RETRY_STATUS)
    if isinstance(rate, bool) or not isinstance(rate, int | float) or not 0 <= rate <= 1:
        raise PlanError(f"{where}: rate must be a number from 0 to 1")
    if isinstance(status, bool) or not isinstance(status, int) or not 500 <= status <= 599:
        raise PlanError(f"{where}: status must be a 5xx integer")
    return RetryFault(index=index, route=parts[0], method=parts[1].upper(), path=parts[2], rate=float(rate), status=status)
