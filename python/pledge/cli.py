"""pledge: boot an app behind the fault proxy, run scenarios under faults, and report which pledges held.

    pledge boot APP_DIR [--env KEY=VALUE ...]
    pledge run APP_DIR --scenario NAME [--faults FILE] [--seed N] [--runs-dir DIR]
    pledge verdict APP_DIR RUN_DIR [RUN_DIR ...]
    pledge down APP_DIR
    pledge restart APP_DIR SERVICE
    pledge scan APP_DIR --scenario NAME --faults FILE [--seeds N] [--env KEY=VALUE ...]
    pledge author APP_DIR --out DIR
    pledge publish APP_DIR RUN_DIR [RUN_DIR ...] [--faults FILE] [--app NAME]
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from pledge import local
from pledge.verdict import PledgeError, format_verdict, verdict


def _env(pairs: list[str]) -> dict[str, str]:
    env = {}
    for pair in pairs:
        name, sep, value = pair.partition("=")
        if not sep or not name:
            raise ValueError(f"--env must be KEY=VALUE, got {pair!r}")
        env[name] = value
    return env


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="pledge")
    commands = parser.add_subparsers(dest="command", required=True)

    boot = commands.add_parser("boot", help="start the app, its fakes and the fault proxy")
    boot.add_argument("app_dir", type=Path)
    boot.add_argument("--env", action="append", default=[], metavar="KEY=VALUE", help="extra environment for the services")

    run = commands.add_parser("run", help="run one scenario under one seed's fault plan")
    run.add_argument("app_dir", type=Path)
    run.add_argument("--scenario", required=True)
    run.add_argument("--faults", type=Path, help="JSON file with a `faults` list; omit for a baseline run")
    run.add_argument("--seed", type=int, default=0)
    run.add_argument("--runs-dir", type=Path, default=Path("runs"))

    report = commands.add_parser("verdict", help="count kept and broken per pledge across runs")
    report.add_argument("app_dir", type=Path)
    report.add_argument("runs", type=Path, nargs="+", metavar="RUN_DIR")
    report.add_argument("--json", action="store_true")

    down = commands.add_parser("down", help="stop what `boot` started")
    down.add_argument("app_dir", type=Path)

    restart = commands.add_parser("restart", help="kill one service as a crash would and start it again (the proxy's `restart` fault calls this)")
    restart.add_argument("app_dir", type=Path)
    restart.add_argument("service")

    scan = commands.add_parser("scan", help="boot the app in an E2B sandbox, fork it per seed, run and judge")
    scan.add_argument("app_dir", type=Path)
    scan.add_argument("--scenario", required=True)
    scan.add_argument("--faults", type=Path, help="omit for baseline runs")
    scan.add_argument("--seeds", type=int, default=5)
    scan.add_argument("--env", action="append", default=[], metavar="KEY=VALUE")
    scan.add_argument("--runs-dir", type=Path, default=Path("runs"))
    scan.add_argument("--json", action="store_true")
    scan.add_argument("--snapshot", help="start from this saved sandbox; default: the one `pledge author` saved for this directory")
    scan.add_argument("--publish", action="store_true", help="send the result to the Pledge API for the dashboard")
    scan.add_argument("--app", help="name shown in the dashboard (default: the app directory's name)")

    publish = commands.add_parser("publish", help="send runs that already exist to the Pledge API for the dashboard")
    publish.add_argument("app_dir", type=Path)
    publish.add_argument("runs", type=Path, nargs="+", metavar="RUN_DIR")
    publish.add_argument("--faults", type=Path, help="the faults file the runs were made under")
    publish.add_argument("--env", action="append", default=[], metavar="KEY=VALUE", help="environment the app ran with, for the record")
    publish.add_argument("--app")

    author = commands.add_parser("author", help="have Claude boot an unseen repo in a sandbox and write its scenarios and pledges")
    author.add_argument("app_dir", type=Path)
    author.add_argument("--out", type=Path, required=True, help="empty directory for the repo plus the authored files")
    author.add_argument("--json", action="store_true")
    author.add_argument("--publish", action="store_true", help="show the run live in the dashboard and send its baseline results")
    author.add_argument("--app", help="repo name shown in the dashboard (default: the app directory's name)")
    return parser


def _live(args: argparse.Namespace, trigger: str, phase: str, scenario: str | None = None, seeds: int | None = None):
    from pledge.publish import LiveRun

    live = LiveRun(args.app or args.app_dir.resolve().name, trigger, phase, scenario, seeds)
    print(f"live: {live.url}", file=sys.stderr)
    return live


def _publish_baselines(args: argparse.Namespace, report: dict, live) -> None:
    """After authoring: each scenario's baseline is a run. The first finishes the live run; a run has one
    scenario, so the others are sent as runs of their own."""
    from pledge.publish import LiveRun, build_record

    out = args.out.resolve()
    for index, baseline in enumerate(report["baseline"]):
        run_dir = out / ".pledge-runs" / "baseline" / baseline["run_id"]
        record = build_record(out, verdict(out, [run_dir]), [run_dir], None, {})
        target = live if index == 0 else LiveRun(live.repo_id, "first_scan", "run", baseline["scenario"], 1)
        target.finish(record)
        print(f"published: {target.url}", file=sys.stderr)
    if not report["baseline"]:
        live.failed("authoring produced no baseline run")


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        if args.command == "boot":
            print(json.dumps(local.boot(args.app_dir, _env(args.env))))
            return 0
        if args.command == "down":
            print(json.dumps(local.down(args.app_dir)))
            return 0
        if args.command == "restart":
            print(json.dumps(local.restart_service(args.app_dir, args.service)))
            return 0
        if args.command == "run":
            print(json.dumps(local.run(args.app_dir, args.scenario, args.faults, args.seed, args.runs_dir)))
            return 0
        if args.command == "author":
            from pledge.agent import AgentError  # imported here: only this command needs the Anthropic SDK
            from pledge.author import author, format_report

            live = _live(args, "first_scan", "boot") if args.publish else None
            try:
                report = author(args.app_dir, args.out, live)
            except (AgentError, RuntimeError, OSError) as exc:
                if live:
                    live.failed(str(exc))
                print(f"pledge: {exc}", file=sys.stderr)
                return 3
            print(json.dumps(report) if args.json else "\n".join(format_report(report)))
            if live:
                _publish_baselines(args, report, live)
            return 0
        if args.command == "scan":
            from pledge.scan import authored_snapshot, scan  # imported here: only this command needs the E2B SDK

            from pledge.publish import seed_counts

            snapshot = args.snapshot or authored_snapshot(args.app_dir.resolve())
            live = _live(args, "manual", "run", args.scenario, args.seeds) if args.publish else None
            try:
                report = scan(args.app_dir, args.scenario, args.faults, args.seeds, _env(args.env), args.runs_dir, snapshot, (lambda run_dir: live.event("seed_finished", **seed_counts(run_dir))) if live else None)
            except (ValueError, RuntimeError, OSError) as exc:
                if live:
                    live.failed(str(exc))
                raise
        else:
            report = verdict(args.app_dir, args.runs)
            live = _live(args, "manual", "run", report["scenario"], len(args.runs)) if args.command == "publish" else None
        print(json.dumps(report) if getattr(args, "json", False) else "\n".join(format_verdict(report)))
        if live:
            from pledge.publish import build_record

            run_dirs = [Path(path) for path in report.get("run_dirs", [])] or args.runs
            live.finish(build_record(args.app_dir, report, run_dirs, args.faults, _env(args.env)))
            live.media(run_dirs)
            print(f"published: {live.url}", file=sys.stderr)
        return {"kept": 0, "broken": 1}.get(report["verdict"], 2)
    except (local.BootError, PledgeError, ValueError, OSError, RuntimeError) as exc:
        print(f"pledge: {exc}", file=sys.stderr)
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
