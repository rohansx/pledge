/**
 * The hash chain. Pure functions, no database, no I/O.
 *
 * This module and canonical-json.ts are the entire cryptographic content of the ledger. They
 * are separated from @pledge/db on purpose: `npx pledge-verify` recomputes these hashes on a
 * machine that has never heard of our Postgres, and a verifier that has to install a database
 * driver to check a receipt is a verifier nobody runs.
 *
 * THE FORMULA (docs/architecture.md §5.2, docs/technical-spec.md §3) — normative:
 *
 *     payload_sha256 = sha256(JCS(payload))
 *     entry_hash[n]  = sha256(entry_hash[n-1] || payload_sha256[n] || u64le(seq[n]))
 *     entry_hash[0]'s prev_hash = 32 zero bytes
 *
 * Changing any part of it invalidates every receipt ever issued. There is no migration for
 * that; there is only a new format version.
 *
 * WHY `seq` IS IN THE HASH: without it, an operator could splice out entry n and re-point
 * n+1's prev_hash, and the chain would still fold. Binding the position makes the *length*
 * of the prefix part of what each entry commits to, so a deletion shows up as a gap that
 * cannot be closed. Gaplessness is therefore verifiable independently of trusting us
 * (docs/security.md T-03).
 */
import { createHash } from "node:crypto";
import { canonicalJson, type JsonValue } from "./canonical-json.ts";

/** Lowercase hex sha256. Every hash crossing a boundary in this codebase is this shape. */
export type HashHex = string;

export const HASH_HEX_PATTERN = /^[0-9a-f]{64}$/;

export function isHashHex(value: string): boolean {
  return HASH_HEX_PATTERN.test(value);
}

/**
 * The chain's first `prev_hash`: 32 zero bytes. Not a hash of anything — there is nothing
 * before genesis to hash, and inventing a magic string here would be a second thing every
 * independent verifier has to be told about.
 */
export const GENESIS_PREV_HASH: HashHex = "0".repeat(64);

/** The first entry's `seq`. `chain_head` starts at 0, so the first append is 1. */
export const FIRST_SEQ = 1;

function sha256Hex(...parts: readonly (Uint8Array | string)[]): HashHex {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(typeof part === "string" ? Buffer.from(part, "utf8") : part);
  }
  return hash.digest("hex");
}

/** sha256 over the JCS form of a payload. The only permitted way to produce payload_sha256. */
export function payloadSha256(payload: JsonValue): HashHex {
  return sha256Hex(canonicalJson(payload));
}

/**
 * `u64le(seq)` — 8 bytes, little-endian, per the formula in technical-spec §3.
 *
 * BigInt rather than `writeUInt32LE` pairs, because getting the endianness of a manual split
 * wrong is silent: it produces stable, self-consistent, wrong hashes that only fail against
 * an independent implementation, i.e. in front of the one audience that matters.
 */
function u64le(seq: number): Uint8Array {
  if (!Number.isSafeInteger(seq) || seq < FIRST_SEQ) {
    throw new RangeError(`ledger seq must be a safe integer >= ${FIRST_SEQ}, got ${seq}`);
  }
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(seq));
  return buf;
}

/**
 * The chain step, given a payload digest rather than a payload.
 *
 * `pledge-verify` needs exactly this: a receipt carries the ledger triple (seq, prev_hash,
 * payload_sha256) and its entry_hash, but not the payload itself, so it can check that the
 * triple folds without being able to recompute the digest. Exported so the verifier does not
 * reimplement the formula — a second copy that drifted would let the verifier agree with a
 * writer that is wrong, which is the one failure mode this module is built to exclude.
 */
export function entryHashFrom(input: {
  readonly seq: number;
  readonly prevHash: HashHex;
  readonly payloadSha256: HashHex;
}): HashHex {
  const { seq, prevHash, payloadSha256: digest } = input;
  if (!isHashHex(prevHash)) {
    throw new TypeError(`prevHash must be 64 lowercase hex chars, got ${JSON.stringify(prevHash)}`);
  }
  if (!isHashHex(digest)) {
    throw new TypeError(`payloadSha256 must be 64 lowercase hex chars, got ${JSON.stringify(digest)}`);
  }
  return sha256Hex(Buffer.from(prevHash, "hex"), Buffer.from(digest, "hex"), u64le(seq));
}

export interface ComputedEntry {
  readonly seq: number;
  readonly prevHash: HashHex;
  readonly payloadSha256: HashHex;
  readonly entryHash: HashHex;
}

/**
 * The whole chain step for one entry. Both the append path and the verification walk call
 * this — deliberately, so that a bug in the formula cannot make the verifier agree with a
 * writer that is wrong. One implementation, two consumers.
 */
export function computeEntry(input: {
  readonly seq: number;
  readonly prevHash: HashHex;
  readonly payload: JsonValue;
}): ComputedEntry {
  const { seq, prevHash, payload } = input;
  const digest = payloadSha256(payload);
  return {
    seq,
    prevHash,
    payloadSha256: digest,
    entryHash: entryHashFrom({ seq, prevHash, payloadSha256: digest }),
  };
}

/** One entry as stored, in the shape the verification walk needs. */
export interface StoredEntry {
  readonly seq: number;
  readonly payload: JsonValue;
  readonly payloadSha256: HashHex;
  readonly prevHash: HashHex;
  readonly entryHash: HashHex;
}

export interface ChainBreak {
  readonly seq: number;
  /**
   * `gap` is listed first because it is the one that means an entry was *removed*, which is
   * the tampering this chain exists to expose (docs/security.md T-03).
   */
  readonly kind:
    | "gap"
    | "prev_hash_mismatch"
    | "payload_hash_mismatch"
    | "entry_hash_mismatch"
    | "payload_schema_mismatch";
  readonly expected: string;
  readonly actual: string;
}

/**
 * Walks entries in `seq` order and recomputes everything. Returns every break it finds
 * rather than the first: "the chain is broken from 4711 onwards" and "the chain has one bad
 * entry at 4711" are very different incidents and the caller should be able to tell them
 * apart.
 *
 * Pure — the caller supplies the rows. @pledge/db owns reading them.
 */
export function verifyChain(
  entries: Iterable<StoredEntry>,
  /**
   * Where this batch is expected to start. Defaults to genesis. A caller streaming the chain
   * in pages passes the previous page's tail, so a break that straddles a page boundary is
   * caught by the same code as every other break — batching is not the caller's problem.
   */
  start: { readonly seq?: number; readonly prevHash?: HashHex } = {},
): readonly ChainBreak[] {
  const breaks: ChainBreak[] = [];
  let expectedSeq = start.seq ?? FIRST_SEQ;
  let prevHash = start.prevHash ?? GENESIS_PREV_HASH;

  for (const entry of entries) {
    if (entry.seq !== expectedSeq) {
      breaks.push({
        seq: entry.seq,
        kind: "gap",
        expected: String(expectedSeq),
        actual: String(entry.seq),
      });
    }

    if (entry.prevHash !== prevHash) {
      breaks.push({
        seq: entry.seq,
        kind: "prev_hash_mismatch",
        expected: prevHash,
        actual: entry.prevHash,
      });
    }

    // Recomputed from the entry's own claimed position and prev_hash, not from the walk's
    // running values: otherwise a single gap would cascade into a mismatch on every
    // subsequent entry and the report would name thousands of innocent rows.
    const recomputed = computeEntry({
      seq: entry.seq,
      prevHash: entry.prevHash,
      payload: entry.payload,
    });

    if (recomputed.payloadSha256 !== entry.payloadSha256) {
      breaks.push({
        seq: entry.seq,
        kind: "payload_hash_mismatch",
        expected: recomputed.payloadSha256,
        actual: entry.payloadSha256,
      });
    }
    if (recomputed.entryHash !== entry.entryHash) {
      breaks.push({
        seq: entry.seq,
        kind: "entry_hash_mismatch",
        expected: recomputed.entryHash,
        actual: entry.entryHash,
      });
    }

    expectedSeq = entry.seq + 1;
    prevHash = entry.entryHash;
  }

  return breaks;
}
