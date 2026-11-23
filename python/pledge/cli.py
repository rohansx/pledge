"""pledge: boot an app behind the fault proxy, run scenarios under faults, and report which pledges held.

    pledge boot APP_DIR [--env KEY=VALUE ...]
    pledge run APP_DIR --scenario NAME [--faults FILE] [--seed N] [--runs-dir DIR]
    pledge verdict APP_DIR RUN_DIR [RUN_DIR ...]
    pledge down APP_DIR
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

    scan = commands.add_parser("scan", help="boot the app in an E2B sandbox, fork it per seed, run and judge")
    scan.add_argument("app_dir", type=Path)
    scan.add_argument("--scenario", required=True)
    scan.add_argument("--faults", type=Path, help="omit for baseline runs")
    scan.add_argument("--seeds", type=int, default=5)
    scan.add_argument("--env", action="append", default=[], metavar="KEY=VALUE")
    scan.add_argument("--runs-dir", type=Path, default=Path("runs"))
    scan.add_argument("--json", action="store_true")
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
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        if args.command == "boot":
            print(json.dumps(local.boot(args.app_dir, _env(args.env))))
            return 0
        if args.command == "down":
            print(json.dumps(local.down(args.app_dir)))
            return 0
        if args.command == "run":
            print(json.dumps(local.run(args.app_dir, args.scenario, args.faults, args.seed, args.runs_dir)))
            return 0
        if args.command == "author":
            from pledge.agent import AgentError  # imported here: only this command needs the Anthropic SDK
            from pledge.author import author, format_report

            try:
                report = author(args.app_dir, args.out)
            except AgentError as exc:
                print(f"pledge: {exc}", file=sys.stderr)
                return 3
            print(json.dumps(report) if args.json else "\n".join(format_report(report)))
            return 0
        if args.command == "scan":
            from pledge.scan import scan  # imported here: only this command needs the E2B SDK

            report = scan(args.app_dir, args.scenario, args.faults, args.seeds, _env(args.env), args.runs_dir)
        else:
            report = verdict(args.app_dir, args.runs)
        print(json.dumps(report) if args.json else "\n".join(format_verdict(report)))
        if args.command == "publish" or getattr(args, "publish", False):
            from pledge.publish import build_record, publish

            run_dirs = [Path(path) for path in report.get("run_dirs", [])] or args.runs
            stored = publish(build_record(args.app_dir, report, run_dirs, args.faults, _env(args.env), args.app))
            print(f"published: {stored['url']}", file=sys.stderr)
        return {"kept": 0, "broken": 1}.get(report["verdict"], 2)
    except (local.BootError, PledgeError, ValueError, OSError, RuntimeError) as exc:
        print(f"pledge: {exc}", file=sys.stderr)
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
