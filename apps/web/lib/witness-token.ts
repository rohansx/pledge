/**
 * The magic link a witness attests from (ADR-0006, security.md T-02).
 *
 * A witness has no account and never gets one, so possession of the link is the whole of the
 * authentication. Four properties make that tolerable, and every one of them is here or in the
 * row the token points at:
 *
 *   HMAC'd        — an attacker who knows a `witness.id` still cannot make a working link.
 *                   Forgery is rejected here, before any query runs.
 *   scoped        — one token addresses exactly one `witness.id`. There is no "all my
 *                   invitations" link and no id to increment.
 *   expiring      — 14 days, in the token AND in `witness.expires_at`. The signature covers
 *                   the expiry, so a caller cannot extend their own link by editing it.
 *   single-use    — enforced by `witness.used_at`, not here: a token is a *name*, and spending
 *                   is a fact about the row it names (see ./witness.ts).
 *
 * The token is DETERMINISTIC in (witnessId, expiresAt, secret). That is deliberate and load-
 * bearing: the outcome mail has to re-send the same link, and the database stores only
 * `sha256(token)` — by design, so a database leak hands out no working links. A random token
 * would mean either storing the plaintext or losing the ability to remind a witness.
 *
 * WHY sha256(token) AND NOT sha256(witnessId): the stored hash is what the lookup keys on, so
 * a bug that mangles the id cannot land on some other witness's row — it simply finds nothing.
 *
 * Rotating WITNESS_LINK_SECRET invalidates every outstanding link. That is the correct
 * behaviour for a leaked secret and the reason it is its own variable rather than a reuse of
 * AUTH_SECRET: rotating one must not be forced to rotate the other.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { requireEnv } from "@pledge/db";

/** ADR-0006: "expires after 14 days". Stated once, here. */
export const WITNESS_LINK_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/** UUID v4, lowercase — the shape `witness.id` takes. Anything else is not worth hashing. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface MintedWitnessToken {
  /** Goes in the email. Never stored. */
  readonly token: string;
  /** Goes in `witness.token_hash`. Never emailed. */
  readonly tokenHash: string;
  readonly expiresAt: Date;
}

/** Why a token was refused. Deliberately coarse — see `witnessTokenRefusal` below. */
export type WitnessTokenError = "malformed" | "bad_signature" | "expired";

export type ParsedWitnessToken =
  | {
      readonly ok: true;
      readonly witnessId: string;
      readonly expiresAt: Date;
      readonly tokenHash: string;
    }
  | { readonly ok: false; readonly reason: WitnessTokenError };

function secret(): Buffer {
  // requireEnv throws with a pointer to .env.example rather than letting an empty string
  // silently become a signing key that anyone can reproduce.
  return Buffer.from(requireEnv("WITNESS_LINK_SECRET"), "utf8");
}

function sign(witnessId: string, expiresAtSeconds: number): string {
  return createHmac("sha256", secret())
    .update(`${witnessId}.${expiresAtSeconds}`)
    .digest("base64url");
}

export function hashWitnessToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Builds the link token for an invitation. `expiresAt` is truncated to whole seconds because
 * it is carried in the token as an integer — a Date with milliseconds would sign one value and
 * verify another.
 */
export function mintWitnessToken(witnessId: string, expiresAt: Date): MintedWitnessToken {
  if (!UUID_RE.test(witnessId)) {
    throw new Error("mintWitnessToken: witnessId must be a lowercase UUID");
  }
  const seconds = Math.floor(expiresAt.getTime() / 1000);
  const token = `${witnessId}.${seconds}.${sign(witnessId, seconds)}`;
  return { token, tokenHash: hashWitnessToken(token), expiresAt: new Date(seconds * 1000) };
}

/**
 * Verifies a token offline. No database, so a forged or expired link costs one HMAC and
 * nothing else — which is what keeps `/w/<anything>` from being a query amplifier.
 *
 * `now` is injected rather than read here so the expiry boundary is testable. The database's
 * own `expires_at` check is still authoritative at attestation time (./witness.ts): this one
 * is a cheap gate, not the control.
 */
export function parseWitnessToken(token: string, now: Date = new Date()): ParsedWitnessToken {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [witnessId, secondsText, signature] = parts as [string, string, string];

  if (!UUID_RE.test(witnessId)) return { ok: false, reason: "malformed" };
  if (!/^[0-9]{1,15}$/.test(secondsText)) return { ok: false, reason: "malformed" };
  const seconds = Number(secondsText);

  const expected = sign(witnessId, seconds);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  // Length-check first: timingSafeEqual throws on a mismatch, and the length of an HMAC
  // digest is not a secret.
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "bad_signature" };
  }

  const expiresAt = new Date(seconds * 1000);
  if (expiresAt.getTime() <= now.getTime()) return { ok: false, reason: "expired" };

  return { ok: true, witnessId, expiresAt, tokenHash: hashWitnessToken(token) };
}

/**
 * What a refused link is allowed to say out loud.
 *
 * security.md T-02: do not echo secrets in error messages. It also does not distinguish
 * "wrong signature" from "no such witness" to the caller, because the difference is only
 * useful to someone probing for valid ids.
 */
export function witnessTokenRefusal(): string {
  return "This link is not valid. It may have expired, or it may already have been used.";
}
