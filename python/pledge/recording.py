"""A recording of one journey that broke a pledge: its requests in order, the faults the proxy injected into
them, and the check that failed. Built from a run directory after the run, for the dashboard to play back.

The proxy logs every request with the journey key the scenario sent in `X-Pledge-Journey`. Calls the app made
to its dependencies carry no journey key, so they are not in the recording.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

MAX_STEPS = 80
GRAPHQL_OPERATION = re.compile(r"\b(mutation|query)\b[^{]*\{\s*(\w+)")


def _journey(row: dict, traffic: list[dict]) -> str | None:
    """The journey to replay: the one the check named, else (for a whole-run check) the user journey whose lost
    reply came furthest into its flow, earliest on a tie. Late requests commit state (a capture, a completed
    order); early ones are logins and lookups. The engine's own `setup` is a last resort: it shows a login.
    ponytail: "furthest in" is a guess at the journey that shows the bug; matching the fault to the check is better."""
    for failure in row.get("failures") or []:
        if failure.get("logical_key"):
            return failure["logical_key"]
    seen: dict[str, int] = {}
    depth: dict[str, float] = {}  # journey -> position of its last lost reply, as a share of its requests so far
    for entry in traffic:
        journey = entry.get("journey")
        if not journey:
            continue
        seen[journey] = seen.get(journey, 0) + 1
        if entry.get("fault") is not None:
            depth[journey] = seen[journey]
    for journey in depth:
        depth[journey] /= seen[journey]
    users = {journey: share for journey, share in depth.items() if journey != "setup"} or depth
    return max(users, key=lambda journey: users[journey]) if users else None  # dicts keep order: earliest wins a tie


def _step(entry: dict, start: int) -> dict:
    where = f"{entry['method']} {entry['path']}"
    operation = GRAPHQL_OPERATION.search(entry.get("request") or "")
    if operation and "graphql" in entry["path"]:
        where += f" {operation.group(2)}"  # every GraphQL step is the same POST; the operation says what it did
    detail = {"request": entry.get("request", ""), "reply": entry.get("reply", "")}
    at, upstream, returned = entry["at_ms"] - start, entry.get("upstream_status"), entry["returned_status"]
    answered = f"the app answered {upstream}" if upstream is not None else "the app did not answer"
    # A log written before the proxy had other kinds says only that a fault hit: that was a lost reply.
    kinds = entry.get("kinds") or (["retry"] if entry.get("fault") is not None else [])
    if entry.get("copy"):
        when = "at the same instant as the first" if "race" in kinds else "though nobody sent it twice"
        return {"at": at, "actor": "fault", "text": f"{where}: the same request was delivered a second time, {when}. This time {answered}; nobody was waiting for that reply.", "detail": detail}
    if not kinds:
        outcome = f"app unreachable ({returned})" if upstream is None else str(returned)
        return {"at": at, "actor": "client", "text": f"{where} → {outcome}", "detail": detail}
    told = []
    if "restart" in kinds:
        told.append(f"{entry.get('service', 'a service')} was killed and started again while this request was in flight")
    if "race" in kinds:
        told.append("the request was sent twice at the same instant, as a double click or two workers would")
    if "duplicate" in kinds:
        told.append("the request will be delivered a second time, as a provider redelivering a webhook would")
    if "delay" in kinds:
        told.append(f"the reply was held for {entry.get('delay_ms', '?')} ms")
    if "retry" in kinds:
        told.append(f"the app did the work and answered {upstream}, but the reply was lost")
    text = f"{where}: {'; '.join(told)}. The client got {returned}."
    return {"at": at, "actor": "fault", "text": text, "detail": detail}


def recording(run_dir: Path, assertion: str, statement: str) -> dict | None:
    """None when the run has no traffic log, the check did not fail, or no request carried a journey key."""
    traffic_file = run_dir / "pledge" / "proxy_traffic.json"
    if not traffic_file.is_file():
        return None
    result = json.loads((run_dir / "result.json").read_text())
    row = next((row for row in result["assertions"] if row["id"] == assertion and row["status"] == "fail"), None)
    if row is None:
        return None
    traffic = json.loads(traffic_file.read_text())
    journey = _journey(row, traffic)
    # The log is written as replies finish; concurrent copies finish out of order, so replay by start time.
    entries = sorted((entry for entry in traffic if journey and entry.get("journey") == journey), key=lambda entry: entry["at_ms"])
    if not entries:
        return None
    start = entries[0]["at_ms"]
    steps = [_step(entry, start) for entry in entries[:MAX_STEPS]]
    failure = next((f for f in row.get("failures") or [] if f.get("logical_key") == journey), row)
    found = f"expected {json.dumps(failure.get('expected'))[:200]}, found {json.dumps(failure.get('actual'))[:200]}"
    steps.append({"at": entries[-1]["at_ms"] - start, "actor": "check", "text": f"Broken: {statement[:700]} ({found})", "detail": None})
    return {"seed": result["seed"], "journey": journey, "faults_hit": sum(entry.get("fault") is not None and not entry.get("copy") for entry in entries), "steps": steps}
