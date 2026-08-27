/**
 * ed25519 signing — step 2 of verification (docs/spec/receipt-format.md §4).
 *
 * Step 1 is "recompute the payload hash", which needs no key and is ./chain. Step 2 is "the
 * signature over those bytes verifies against a public key". Steps 3–5 are Merkle inclusion
 * and Rekor, and they are **not v1**: ADR-0005 is Proposed, not accepted, and nothing here
 * assumes an outcome either way.
 *
 * WHY node:crypto AND NOT @noble/ed25519
 * --------------------------------------
 * Node has had first-class ed25519 since 12. It gives us the exact SPKI DER encoding that
 * receipt-format §2 shows in its `public_key` example (`MCowBQYDK2VwAyEA…`), where noble
 * hands back a raw 32-byte key we would then have to wrap in the same DER by hand. Both the
 * signer and `npx pledge-verify` are Node processes, so the portability argument for a pure-JS
 * implementation does not apply. Zero dependencies for a security-critical primitive is worth
 * more than the ergonomics. If the verifier ever has to run in a browser, this is a ~20-line
 * swap and the wire format does not change.
 *
 * WHAT IS SIGNED
 * --------------
 * Always `<context>\x00 || JCS(value)`. The domain-separation prefix is not decoration: it is
 * what stops a signature over a ledger payload being presented as a signature over a receipt
 * subset. Two different things must never be signable as the same bytes.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto";
import type { KeyObject } from "node:crypto";
import { canonicalJson, type JsonValue } from "./canonical-json";

/** Domain separation. `receipt-format` §3 fixes the receipt one; this is the ledger's. */
export const LEDGER_SIGNING_CONTEXT = "pledge.ledger.v1";

/** Base64 of the PKCS#8 DER private key. Never a file in the repo, never a default. */
const KEY_ENV = "PLEDGE_SIGNING_KEY";

export interface SigningKey {
  readonly privateKey: KeyObject;
  /** SPKI DER, standard base64 — the `signature.public_key` field of a receipt. */
  readonly publicKeySpki: string;
  /** `sha256:<hex>` over the SPKI DER — the `signature.key_id` field of a receipt. */
  readonly keyId: string;
}

function toSigningKey(privateKey: KeyObject): SigningKey {
  const spki = createPublicSpki(privateKey);
  return {
    privateKey,
    publicKeySpki: spki.toString("base64"),
    keyId: `sha256:${createHash("sha256").update(spki).digest("hex")}`,
  };
}

function createPublicSpki(privateKey: KeyObject): Buffer {
  return createPublicKey(privateKey).export({ format: "der", type: "spki" });
}

let cached: SigningKey | undefined;

/**
 * The service key, from `PLEDGE_SIGNING_KEY`.
 *
 * If it is missing outside production, a throwaway key is generated so `pnpm test` and a
 * local `pnpm dev` work with no setup — and the process says so, loudly and with the value
 * needed to make it stable. In production a missing key is a startup failure, because signing
 * receipts with a key that changes on every deploy silently invalidates every receipt already
 * handed out, and the failure would surface as a stranger's verifier saying "FORGED".
 */
export function getSigningKey(): SigningKey {
  if (cached !== undefined) return cached;

  const encoded = process.env[KEY_ENV];
  if (encoded !== undefined && encoded !== "") {
    const privateKey = createPrivateKey({
      key: Buffer.from(encoded, "base64"),
      format: "der",
      type: "pkcs8",
    });
    if (privateKey.asymmetricKeyType !== "ed25519") {
      throw new Error(`${KEY_ENV} is a ${privateKey.asymmetricKeyType ?? "unknown"} key; ed25519 required`);
    }
    return (cached = toSigningKey(privateKey));
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      `${KEY_ENV} is not set. Refusing to generate one: an ephemeral key would invalidate ` +
        `every receipt already issued, and the failure would only show up in someone else's verifier.`,
    );
  }

  const { privateKey } = generateKeyPairSync("ed25519");
  const der = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
  console.warn(
    `${KEY_ENV} is not set — generated an ephemeral dev key. Signatures will not verify ` +
      `across restarts. To pin it, add to .env.local:\n  ${KEY_ENV}=${der}`,
  );
  return (cached = toSigningKey(privateKey));
}

/** Test-only. Nothing in a request or worker path has any business rotating a key mid-process. */
export function resetSigningKeyCache(): void {
  cached = undefined;
}

/** `<context>\x00 || JCS(value)` — the exact bytes a verifier must reconstruct. */
export function signedBytes(context: string, value: JsonValue): Buffer {
  return Buffer.from(`${context}\0${canonicalJson(value)}`, "utf8");
}

export interface Signature {
  readonly alg: "ed25519";
  /** SPKI DER, standard base64. */
  readonly publicKey: string;
  readonly keyId: string;
  /** Unpadded base64url, per receipt-format §2.1 ("all binary values are unpadded base64url"). */
  readonly value: string;
}

/**
 * Signs any JSON value under a caller-chosen context.
 *
 * Deliberately generic: the receipt builder signs a receipt subset under
 * `pledge.receipt.v1`, and it should use this rather than growing a second signing path with
 * its own key handling.
 */
export function signValue(context: string, value: JsonValue, key: SigningKey = getSigningKey()): Signature {
  return {
    alg: "ed25519",
    publicKey: key.publicKeySpki,
    keyId: key.keyId,
    value: sign(null, signedBytes(context, value), key.privateKey).toString("base64url"),
  };
}

/** Signs a ledger entry payload under the ledger context. */
export function signLedgerPayload(payload: JsonValue, key?: SigningKey): Signature {
  return signValue(LEDGER_SIGNING_CONTEXT, payload, key);
}

/**
 * The verifier's half. No environment, no key material of ours, no network — everything it
 * needs is in its arguments, which is what makes `npx pledge-verify` runnable by someone who
 * has never heard of us (docs/architecture.md §6.5).
 *
 * Returns false rather than throwing on malformed input: a verifier's job is to answer
 * "does this verify", and a corrupt key or signature is an answer, not a crash.
 */
export function verifySignature(
  context: string,
  value: JsonValue,
  signature: { readonly publicKey: string; readonly value: string },
): boolean {
  try {
    const publicKey = createPublicKey({
      key: Buffer.from(signature.publicKey, "base64"),
      format: "der",
      type: "spki",
    });
    if (publicKey.asymmetricKeyType !== "ed25519") return false;
    return verify(
      null,
      signedBytes(context, value),
      publicKey,
      Buffer.from(signature.value, "base64url"),
    );
  } catch {
    return false;
  }
}
