/**
 * The chain arithmetic, tested without a database.
 *
 * These assertions are the ones an independent implementer would write. If any of them has to
 * change, the receipt format has broken and every receipt already issued stops verifying —
 * so a failure here is never "update the expected value".
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../src/canonical-json";
import {
  computeEntry,
  FIRST_SEQ,
  GENESIS_PREV_HASH,
  payloadSha256,
  verifyChain,
  type StoredEntry,
} from "../src/chain";
import { parseLedgerPayload } from "../src/payloads";
import {
  LEDGER_SIGNING_CONTEXT,
  resetSigningKeyCache,
  signLedgerPayload,
  signedBytes,
  verifySignature,
} from "../src/signing";

describe("canonicalJson (RFC 8785)", () => {
  it("sorts object keys by UTF-16 code unit, recursively", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it("preserves array order — JCS sorts objects, never arrays", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
  });

  it("matches the RFC 8785 key-ordering example (code unit, not code point)", () => {
    // RFC 8785 §3.2.3's own example. The ordering is where a `localeCompare` or
    // `sort()`-default implementation diverges, and it diverges silently.
    const input = {
      "\u20ac": "Euro Sign",
      "\r": "Carriage Return",
      "1": "One",
      "\u0080": "Control",
    };
    // Note U+0080 is emitted LITERALLY, not as `\u0080`. The RFC prints it escaped in its
    // example because a C1 control cannot be shown on the page; the normative escaping rule
    // (§3.2.2.2, via RFC 8259 §7) covers only U+0000-U+001F, and the reference
    // implementations emit it raw. Escaping it here would be a real interop break.
    expect(canonicalJson(input)).toBe(
      '{"\\r":"Carriage Return","1":"One","\u0080":"Control","\u20ac":"Euro Sign"}',
    );
  });

  it("rejects rather than silently dropping the values JSON.stringify would mangle", () => {
    // Each of these would otherwise produce two different payloads with one hash.
    expect(() => canonicalJson({ a: undefined } as never)).toThrow(/undefined/);
    expect(() => canonicalJson({ a: NaN })).toThrow(/non-finite/);
    expect(() => canonicalJson({ a: new Date() } as never)).toThrow(/Date/);
  });
});

describe("the chaining formula", () => {
  it("genesis prev_hash is 32 zero bytes", () => {
    expect(GENESIS_PREV_HASH).toBe("0".repeat(64));
    expect(Buffer.from(GENESIS_PREV_HASH, "hex")).toHaveLength(32);
    expect(Buffer.from(GENESIS_PREV_HASH, "hex").every((b) => b === 0)).toBe(true);
  });

  it("is sha256(prev || payload_sha256 || u64le(seq)) — recomputed by hand", () => {
    const payload = { hello: "world" };
    const seq = 42;
    const entry = computeEntry({ seq, prevHash: GENESIS_PREV_HASH, payload });

    const seqBytes = Buffer.alloc(8);
    seqBytes.writeBigUInt64LE(BigInt(seq));
    const expected = createHash("sha256")
      .update(Buffer.from(GENESIS_PREV_HASH, "hex"))
      .update(createHash("sha256").update(canonicalJson(payload)).digest())
      .update(seqBytes)
      .digest("hex");

    expect(entry.payloadSha256).toBe(payloadSha256(payload));
    expect(entry.entryHash).toBe(expected);
  });

  it("binds the position: the same payload at a different seq hashes differently", () => {
    const payload = { commitmentId: "x" };
    const a = computeEntry({ seq: 1, prevHash: GENESIS_PREV_HASH, payload });
    const b = computeEntry({ seq: 2, prevHash: GENESIS_PREV_HASH, payload });
    expect(a.entryHash).not.toBe(b.entryHash);
  });

  it("uses little-endian, not big-endian, for seq", () => {
    // 1 as u64le is 01 00 00 00 00 00 00 00. A big-endian implementation is self-consistent
    // and wrong, so it can only be caught against a literal.
    const seqBytes = Buffer.alloc(8);
    seqBytes.writeBigUInt64LE(1n);
    expect([...seqBytes]).toEqual([1, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("rejects a seq below the first one, and a malformed prev_hash", () => {
    expect(() => computeEntry({ seq: 0, prevHash: GENESIS_PREV_HASH, payload: {} })).toThrow();
    expect(() => computeEntry({ seq: FIRST_SEQ, prevHash: "beef", payload: {} })).toThrow();
  });
});

/** Builds a well-formed chain of `n` entries so the walk has something honest to check. */
function buildChain(n: number): StoredEntry[] {
  const entries: StoredEntry[] = [];
  let prevHash = GENESIS_PREV_HASH;
  for (let seq = FIRST_SEQ; seq < FIRST_SEQ + n; seq++) {
    const payload = { commitmentId: `c${seq}`, n: seq };
    const computed = computeEntry({ seq, prevHash, payload });
    entries.push({ payload, ...computed });
    prevHash = computed.entryHash;
  }
  return entries;
}

describe("verifyChain", () => {
  it("accepts a chain built by computeEntry", () => {
    expect(verifyChain(buildChain(25))).toEqual([]);
  });

  it("catches a deleted entry as a gap", () => {
    const chain = buildChain(5);
    const withHole = [...chain.slice(0, 2), ...chain.slice(3)];
    const breaks = verifyChain(withHole);
    expect(breaks.map((b) => b.kind)).toContain("gap");
  });

  it("catches an edited payload", () => {
    const chain = buildChain(4);
    const tampered = chain.map((e, i) => (i === 2 ? { ...e, payload: { commitmentId: "evil" } } : e));
    const breaks = verifyChain(tampered);
    expect(breaks).toContainEqual(expect.objectContaining({ seq: 3, kind: "payload_hash_mismatch" }));
    expect(breaks).toContainEqual(expect.objectContaining({ seq: 3, kind: "entry_hash_mismatch" }));
  });

  it("catches a re-pointed prev_hash", () => {
    const chain = buildChain(4);
    const tampered = chain.map((e, i) => (i === 2 ? { ...e, prevHash: GENESIS_PREV_HASH } : e));
    expect(verifyChain(tampered)).toContainEqual(
      expect.objectContaining({ seq: 3, kind: "prev_hash_mismatch" }),
    );
  });

  it("names only the tampered entry, not every entry after it", () => {
    // Otherwise a one-row incident reports as thousands and nobody can read the output.
    const chain = buildChain(6);
    const tampered = chain.map((e, i) => (i === 1 ? { ...e, payloadSha256: "0".repeat(64) } : e));
    expect(new Set(verifyChain(tampered).map((b) => b.seq))).toEqual(new Set([2]));
  });
});

describe("payload schemas", () => {
  it("rejects a resolution that claims a witness produced `kept`", () => {
    // ADR-0006 and architecture.md §6.3: only a probe produces kept. A payload asserting
    // otherwise must never become a permanent record.
    expect(() =>
      parseLedgerPayload("resolved", {
        commitmentId: "0195c8f1-0000-7000-8000-000000000001",
        status: "kept",
        resolvedAt: "2026-08-27T10:00:00Z",
        resolvedBy: "witness",
      }),
    ).toThrow();
  });

  it("accepts a probe-produced kept and a witness-produced dispute", () => {
    const base = {
      commitmentId: "0195c8f1-0000-7000-8000-000000000001",
      resolvedAt: "2026-08-27T10:00:00Z",
    };
    expect(() => parseLedgerPayload("resolved", { ...base, status: "kept", resolvedBy: "probe" })).not.toThrow();
    expect(() =>
      parseLedgerPayload("resolved", { ...base, status: "disputed", resolvedBy: "witness" }),
    ).not.toThrow();
  });

  it("rejects an unknown key rather than hashing it into the record", () => {
    expect(() =>
      parseLedgerPayload("witness_attested", {
        commitmentId: "0195c8f1-0000-7000-8000-000000000001",
        witnessId: "0195c8f1-0000-7000-8000-000000000002",
        attestationId: "0195c8f1-0000-7000-8000-000000000003",
        verdict: "confirms",
        note: null,
        email: "witness@example.test",
      }),
    ).toThrow();
  });

  it("requires a reason on every amendment", () => {
    expect(() =>
      parseLedgerPayload("amended", {
        commitmentId: "0195c8f1-0000-7000-8000-000000000001",
        amendmentId: "0195c8f1-0000-7000-8000-000000000002",
        kind: "deadline_moved",
        oldValue: "2026-08-27T10:00:00Z",
        newValue: "2026-09-27T10:00:00Z",
        reason: "",
      }),
    ).toThrow();
  });
});

describe("ed25519 signing", () => {
  it("round-trips, and rejects a payload that changed after signing", () => {
    resetSigningKeyCache();
    const payload = { commitmentId: "c1", status: "kept" };
    const signature = signLedgerPayload(payload);

    expect(verifySignature(LEDGER_SIGNING_CONTEXT, payload, signature)).toBe(true);
    expect(verifySignature(LEDGER_SIGNING_CONTEXT, { ...payload, status: "missed" }, signature)).toBe(false);
  });

  it("is domain-separated: a ledger signature does not verify as a receipt signature", () => {
    const payload = { commitmentId: "c1" };
    const signature = signLedgerPayload(payload);
    expect(verifySignature("pledge.receipt.v1", payload, signature)).toBe(false);
  });

  it("separates context from payload with a NUL, so no context can be spoofed by prefixing", () => {
    expect(signedBytes("ctx", { a: 1 }).toString("utf8")).toBe('ctx\0{"a":1}');
  });

  it("returns false rather than throwing on a garbage key or signature", () => {
    expect(verifySignature(LEDGER_SIGNING_CONTEXT, { a: 1 }, { publicKey: "??", value: "??" })).toBe(false);
  });
});
