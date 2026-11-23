"""pledge: boot an app behind the fault proxy, run scenarios under faults, and report which pledges held.

    pledge boot APP_DIR [--env KEY=VALUE ...]
    pledge run APP_DIR --scenario NAME [--faults FILE] [--seed N] [--runs-dir DIR]
    pledge verdict APP_DIR RUN_DIR [RUN_DIR ...]
    pledge down APP_DIR
    pledge scan APP_DIR --scenario NAME --faults FILE [--seeds N] [--env KEY=VALUE ...]
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
        if args.command == "scan":
            from pledge.scan import scan  # imported here: only this command needs the E2B SDK

            report = scan(args.app_dir, args.scenario, args.faults, args.seeds, _env(args.env), args.runs_dir)
        else:
            report = verdict(args.app_dir, args.runs)
        print(json.dumps(report) if args.json else "\n".join(format_verdict(report)))
        return {"kept": 0, "broken": 1}.get(report["verdict"], 2)
    except (local.BootError, PledgeError, ValueError, OSError, RuntimeError) as exc:
        print(f"pledge: {exc}", file=sys.stderr)
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
