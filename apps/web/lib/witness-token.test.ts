/**
 * The magic link's security properties, asserted one at a time.
 *
 * These are the cheap half of "cannot attest twice or after expiry" (roadmap v1 exit criteria).
 * The other half — single-use — is a fact about a database row and is tested in ./witness.test.ts
 * against a real Postgres.
 */
import { beforeAll, describe, expect, it } from "vitest";

// Set before the module is imported: `requireEnv` is read lazily inside the signing helper, but
// leaving this to chance would make the suite depend on a developer's .env.local.
process.env["WITNESS_LINK_SECRET"] = "test-secret-not-a-real-key";

const HOUR = 60 * 60 * 1000;

let mintWitnessToken: typeof import("./witness-token").mintWitnessToken;
let parseWitnessToken: typeof import("./witness-token").parseWitnessToken;
let hashWitnessToken: typeof import("./witness-token").hashWitnessToken;
let WITNESS_LINK_TTL_MS: number;

beforeAll(async () => {
  const mod = await import("./witness-token");
  mintWitnessToken = mod.mintWitnessToken;
  parseWitnessToken = mod.parseWitnessToken;
  hashWitnessToken = mod.hashWitnessToken;
  WITNESS_LINK_TTL_MS = mod.WITNESS_LINK_TTL_MS;
});

const WITNESS_ID = "3f9a1c2e-5b6d-4a7f-8c9e-0d1a2b3c4d5e";
const OTHER_ID = "11111111-2222-4333-8444-555555555555";

describe("witness magic-link tokens", () => {
  it("round-trips the witness id and the expiry", () => {
    const expiresAt = new Date(Date.now() + WITNESS_LINK_TTL_MS);
    const minted = mintWitnessToken(WITNESS_ID, expiresAt);

    const parsed = parseWitnessToken(minted.token);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.witnessId).toBe(WITNESS_ID);
    // Whole seconds: the token signs an integer, so a millisecond that survived minting but
    // not verification would make every link fail its own signature.
    expect(parsed.expiresAt.getTime()).toBe(Math.floor(expiresAt.getTime() / 1000) * 1000);
    expect(parsed.tokenHash).toBe(minted.tokenHash);
  });

  it("ADR-0006: the default lifetime is 14 days", () => {
    expect(WITNESS_LINK_TTL_MS).toBe(14 * 24 * HOUR);
  });

  it("never stores what it emails — the hash is not the token", () => {
    const minted = mintWitnessToken(WITNESS_ID, new Date(Date.now() + HOUR));
    expect(minted.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(minted.token).not.toContain(minted.tokenHash);
    expect(hashWitnessToken(minted.token)).toBe(minted.tokenHash);
  });

  it("is scoped to one witness: swapping the id invalidates the signature", () => {
    const expiresAt = new Date(Date.now() + HOUR);
    const minted = mintWitnessToken(WITNESS_ID, expiresAt);
    const rest = minted.token.slice(minted.token.indexOf("."));

    const parsed = parseWitnessToken(`${OTHER_ID}${rest}`);
    expect(parsed).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("cannot be self-extended: the expiry is signed", () => {
    const expiresAt = new Date(Date.now() + HOUR);
    const minted = mintWitnessToken(WITNESS_ID, expiresAt);
    const [id, , signature] = minted.token.split(".") as [string, string, string];

    const farFuture = Math.floor((Date.now() + 365 * 24 * HOUR) / 1000);
    const parsed = parseWitnessToken(`${id}.${farFuture}.${signature}`);
    expect(parsed).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("refuses an expired token — an exit criterion, tested at the boundary", () => {
    const minted = mintWitnessToken(WITNESS_ID, new Date(Date.now() + HOUR));
    // The token's own expiry, not the one asked for: minting truncates to whole seconds, and
    // the boundary that matters is the one the signature actually covers.
    const at = minted.expiresAt.getTime();

    // One millisecond before: still good.
    expect(parseWitnessToken(minted.token, new Date(at - 1)).ok).toBe(true);
    // Exactly at the expiry, and after it: refused. `<=`, so a token is never valid at the
    // instant it names.
    expect(parseWitnessToken(minted.token, new Date(at))).toEqual({
      ok: false,
      reason: "expired",
    });
    expect(parseWitnessToken(minted.token, new Date(at + 1000))).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("refuses a tampered signature", () => {
    const minted = mintWitnessToken(WITNESS_ID, new Date(Date.now() + HOUR));
    const flipped = `${minted.token.slice(0, -1)}${minted.token.endsWith("A") ? "B" : "A"}`;
    expect(parseWitnessToken(flipped)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it.each([
    ["empty", ""],
    ["no separators", "notatoken"],
    ["too few parts", `${WITNESS_ID}.123`],
    ["too many parts", `${WITNESS_ID}.123.abc.def`],
    ["id is not a uuid", "not-a-uuid.123.abc"],
    ["expiry is not an integer", `${WITNESS_ID}.12e9.abc`],
    ["expiry is negative", `${WITNESS_ID}.-1.abc`],
  ])("refuses a malformed token (%s)", (_label, token) => {
    expect(parseWitnessToken(token)).toEqual({ ok: false, reason: "malformed" });
  });

  it("is deterministic, so the outcome mail can re-send the same link", () => {
    const expiresAt = new Date(Date.now() + HOUR);
    expect(mintWitnessToken(WITNESS_ID, expiresAt).token).toBe(
      mintWitnessToken(WITNESS_ID, expiresAt).token,
    );
  });
});
