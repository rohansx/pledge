#!/usr/bin/env node
/**
 * `npx pledge-verify <receipt.json>` — docs/spec/receipt-format.md §8.
 *
 * THIS PROCESS HAS NO NETWORK CODE AND NEEDS NO CREDENTIALS. Both are deliberate:
 *
 *   · No network (§4.1, first non-negotiable). A verifier that contacts the issuer has
 *     recreated the trust dependency the receipt format exists to remove. There is no fetch,
 *     no DNS, no `issuer` lookup — passing a URL is refused with an explanation rather than
 *     quietly downloaded, so "it never touches the network" stays a property you can check by
 *     reading the imports rather than a promise in a README.
 *   · No credentials. Nothing here reads DATABASE_URL, PLEDGE_SIGNING_KEY, or any environment
 *     variable at all. The exit criterion for v1 is that this runs on a stranger's laptop.
 *
 * Exit codes, because this gets scripted:
 *   0  verified — steps 1 and 2 passed and nothing was rejected
 *   1  rejected — the receipt did not verify, or violates the format
 *   2  usage or I/O error — the tool could not read what it was asked to read
 */
import { readFileSync } from "node:fs";
import { formatReport } from "./report.ts";
import { verifyReceipt } from "./verify.ts";

const USAGE = `pledge-verify — offline verification of a pledge receipt (pledge.receipt.v1)

  pledge-verify <receipt.json> [--key <spki-base64 | key-file>]
  cat receipt.json | pledge-verify -

  --key   Pin the ed25519 public key you expect (SPKI DER, base64 — the same shape as
          signature.public_key). Without it the signature is still checked, but the key is
          bound to no identity and the report says so.

This build implements steps 1-2 of the five in receipt-format.md §4: the canonical hash and
the signature. Inclusion proofs and transparency-log anchoring (steps 3-5) are v2 and are
reported as not performed, never as passed. It never contacts the issuer.`;

interface Args {
  readonly path: string;
  readonly key?: string;
}

function parseArgs(argv: readonly string[]): Args | string {
  const positional: string[] = [];
  let key: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === "--help" || arg === "-h") return USAGE;
    if (arg === "--key") {
      const value = argv[i + 1];
      if (value === undefined) return "--key needs a value";
      key = value;
      i += 1;
      continue;
    }
    if (arg.startsWith("--")) return `unknown option ${arg}`;
    positional.push(arg);
  }

  const path = positional[0];
  if (path === undefined) return USAGE;
  if (positional.length > 1) return "expected exactly one receipt";
  if (/^https?:\/\//i.test(path)) {
    return (
      "pledge-verify does not fetch anything — a verifier that reaches out is a verifier you " +
      "have to trust.\nPipe it instead:  curl -s <url> | pledge-verify -"
    );
  }
  return key === undefined ? { path } : { path, key };
}

/**
 * Accepts the base64 directly, or a file containing it (PEM armour tolerated).
 *
 * The two are told apart by the fixed SPKI DER prefix of an ed25519 public key rather than by
 * guessing at path-ness: base64 contains `/`, so a "does it look like a path" heuristic would
 * turn a mistyped filename into a key that verifies against nothing and report it as a forged
 * receipt. A wrong path should say "cannot read".
 */
const SPKI_ED25519_PREFIX = "MCowBQYDK2Vw";

function loadPinnedKey(value: string): string {
  const raw = value.startsWith(SPKI_ED25519_PREFIX) ? value : readFileSync(value, "utf8");
  return raw
    .split("\n")
    .filter((line) => !line.startsWith("-----"))
    .join("")
    .trim();
}

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  if (typeof args === "string") {
    console.error(args);
    return 2;
  }

  let source: string;
  try {
    source = readFileSync(args.path === "-" ? 0 : args.path, "utf8");
  } catch (error: unknown) {
    console.error(`cannot read ${args.path}: ${error instanceof Error ? error.message : "unknown error"}`);
    return 2;
  }

  let document: unknown;
  try {
    document = JSON.parse(source);
  } catch (error: unknown) {
    // Not a rejection of a receipt — it is not a receipt. Say which it is.
    console.error(`${args.path} is not JSON: ${error instanceof Error ? error.message : "parse error"}`);
    return 2;
  }

  let pinnedPublicKey: string | undefined;
  if (args.key !== undefined) {
    try {
      pinnedPublicKey = loadPinnedKey(args.key);
    } catch (error: unknown) {
      console.error(`cannot read --key: ${error instanceof Error ? error.message : "unknown error"}`);
      return 2;
    }
  }

  const result = verifyReceipt(document, pinnedPublicKey === undefined ? {} : { pinnedPublicKey });
  process.stdout.write(formatReport(result, args.path === "-" ? "<stdin>" : args.path));
  return result.accepted ? 0 : 1;
}

process.exitCode = main();
