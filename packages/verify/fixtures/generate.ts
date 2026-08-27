/**
 * Conformance vectors — docs/spec/receipt-format.md §8: "A third-party implementation is
 * conforming if it agrees on all of them."
 *
 * Run with `pnpm --filter pledge-verify fixtures`. Output is byte-identical every run: every
 * timestamp, id and hash below is a literal, and the signing key is fixed. A fixture set that
 * churned on regeneration would make a real change indistinguishable from noise in a diff, and
 * these files are the format's test suite.
 *
 * THE KEY BELOW IS NOT A SECRET. It is a throwaway ed25519 key that exists to sign test
 * vectors and is published with them on purpose — a verifier is checked by handing it
 * signatures it should accept and signatures it should reject, and both need a key anyone can
 * reproduce. It is never the service key: that one comes from `PLEDGE_SIGNING_KEY` and is
 * never in this repository.
 *
 * The tampered set is generated rather than hand-written: one file per field of the signed
 * subset (§3), each a valid receipt with exactly one field changed and the original signature
 * left in place. Hand-maintaining 40 near-identical JSON files is how a field quietly stops
 * being covered.
 */
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { entryHashFrom, signValue, type SigningKey } from "@pledge/ledger";
import { RECEIPT_FORMAT, RECEIPT_SIGNING_CONTEXT, ReceiptBodySchema, signedSubset } from "../src/receipt.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const TAMPERED = join(HERE, "tampered");

/** Fixture key. Public by design — see the header. */
const FIXTURE_KEY_PKCS8 = "MC4CAQAwBQYDK2VwBCIEIFbq5J18uzE+YxJMNNpvrKdWZuR2zm6HldhQ2xlfbGTL";

function fixtureKey(): SigningKey {
  const privateKey = createPrivateKey({
    key: Buffer.from(FIXTURE_KEY_PKCS8, "base64"),
    format: "der",
    type: "pkcs8",
  });
  const spki = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  return {
    privateKey,
    publicKeySpki: spki.toString("base64"),
    keyId: `sha256:${createHash("sha256").update(spki).digest("hex")}`,
  };
}

const KEY = fixtureKey();

type Json = Record<string, unknown>;

/** A ledger triple that folds, because a fixture that fails step 1 for free tests nothing. */
function ledger(seq: number, prevHex: string, payloadHex: string): Json {
  return {
    entry_seq: seq,
    entry_hash: `sha256:${entryHashFrom({ seq, prevHash: prevHex, payloadSha256: payloadHex })}`,
    prev_hash: `sha256:${prevHex}`,
    payload_sha256: `sha256:${payloadHex}`,
  };
}

const hex = (seed: string): string => createHash("sha256").update(seed).digest("hex");

function sign(body: Json): Json {
  const parsed = ReceiptBodySchema.parse(body);
  const signature = signValue(RECEIPT_SIGNING_CONTEXT, signedSubset(parsed), KEY);
  return {
    ...body,
    signature: {
      alg: signature.alg,
      public_key: signature.publicKey,
      key_id: signature.keyId,
      value: signature.value,
    },
  };
}

const RELEASE_SPEC = {
  spec_version: 1,
  hash: `sha256:${hex("done-spec/release")}`,
  source: 'github.release("rohansx/tethr").tag matches "v0.2.*"',
  probe_class: "standard",
};

const RELEASE_EVIDENCE = {
  source: "github:release:rohansx/tethr",
  observed_at: "2026-09-04T14:21:07Z",
  resolved_ip: "140.82.121.6",
  status: 200,
  headers: { "content-type": "application/json", etag: 'W/"a1b2"' },
  body_sha256: `sha256:${hex("body/release")}`,
  body_bytes: 3312,
  matches: [{ op: "matches", pattern: "v0.2.*", value: "v0.2.1" }],
};

/** The ordinary case: a kept commitment, signed, unanchored. */
const kept: Json = {
  format: RECEIPT_FORMAT,
  issuer: "https://pledge.sh",
  commitment: {
    id: "01843b2f-1c9a-4a2e-8f30-000000000001",
    handle: "rohansx",
    claim: "v0.2 released with Kaggle T4 autoscaling",
    committed_at: "2026-08-25T09:14:22Z",
    deadline_original: "2026-09-05T18:29:00Z",
    deadline_effective: "2026-09-05T18:29:00Z",
    visibility: "public",
    cohort_slug: null,
  },
  done_spec: RELEASE_SPEC,
  outcome: {
    status: "kept",
    resolved_at: "2026-09-04T14:21:07Z",
    resolved_by: "probe",
    days_estimated: 11.4,
    days_actual: 10.2,
    slip_ratio: 0.895,
    unchanged_since_commitment: false,
    censored: false,
  },
  amendments: [],
  evidence: [RELEASE_EVIDENCE],
  attestations: [],
  ledger: ledger(84713, hex("prev/84712"), hex("payload/84713")),
  anchor: null,
  anchor_pending: true,
};

/**
 * §6. `days_actual: null` on a miss is RIGHT-CENSORED — the completion was never observed. The
 * fixture carries an `error` observation beside the `fail` one, because I-7's distinction
 * (unobservable is not false) has to survive into the artifact a third party reads.
 */
const missedCensored: Json = {
  format: RECEIPT_FORMAT,
  issuer: "https://pledge.sh",
  commitment: {
    id: "01843b2f-1c9a-4a2e-8f30-000000000002",
    handle: "rohansx",
    claim: "Launch the ordering flow",
    committed_at: "2026-08-20T06:00:00Z",
    deadline_original: "2026-08-30T18:29:00Z",
    deadline_effective: "2026-08-30T18:29:00Z",
    visibility: "public",
    cohort_slug: null,
  },
  done_spec: {
    spec_version: 1,
    hash: `sha256:${hex("done-spec/launched")}`,
    source: 'http("https://example.com/launched").status == 200',
    probe_class: "trivial",
  },
  outcome: {
    status: "missed",
    resolved_at: "2026-08-30T18:29:00Z",
    resolved_by: "probe",
    days_estimated: 8,
    days_actual: null,
    slip_ratio: null,
    unchanged_since_commitment: false,
    censored: true,
  },
  amendments: [],
  evidence: [
    {
      source: "http:https://example.com/launched",
      observed_at: "2026-08-29T18:29:00Z",
      resolved_ip: null,
      status: null,
      headers: {},
      body_sha256: null,
      body_bytes: null,
      matches: [],
    },
    {
      source: "http:https://example.com/launched",
      observed_at: "2026-08-30T18:29:00Z",
      resolved_ip: "93.184.216.34",
      status: 404,
      headers: { "content-type": "text/html" },
      body_sha256: `sha256:${hex("body/404")}`,
      body_bytes: 1256,
      matches: [],
    },
  ],
  attestations: [],
  ledger: ledger(84720, hex("prev/84719"), hex("payload/84720")),
  anchor: null,
  anchor_pending: true,
};

/** Two recorded deadline moves. `deadline_original` is the one the promise was made with. */
const amended: Json = {
  ...kept,
  commitment: {
    ...(kept.commitment as Json),
    id: "01843b2f-1c9a-4a2e-8f30-000000000003",
    claim: "Ship the pledge landing page",
    deadline_original: "2026-08-28T18:29:00Z",
    deadline_effective: "2026-09-05T18:29:00Z",
  },
  amendments: [
    {
      kind: "deadline_moved",
      old_value: "2026-08-28T18:29:00Z",
      new_value: "2026-09-01T18:29:00Z",
      reason: "Upstream API contract changed; the integration needs a rewrite.",
      created_at: "2026-08-27T10:02:11Z",
      ledger_seq: 84690,
    },
    {
      kind: "deadline_moved",
      old_value: "2026-09-01T18:29:00Z",
      new_value: "2026-09-05T18:29:00Z",
      reason: "Second slip: the rewrite needs review time I did not budget.",
      created_at: "2026-08-31T19:40:03Z",
      ledger_seq: 84701,
    },
  ],
  ledger: ledger(84714, hex("prev/84713"), hex("payload/84714")),
};

/** A witness disputed the record. §2.1: `witness` may accompany only `disputed`. */
const disputed: Json = {
  ...kept,
  commitment: {
    ...(kept.commitment as Json),
    id: "01843b2f-1c9a-4a2e-8f30-000000000004",
    claim: "Migrate the billing worker",
  },
  outcome: {
    status: "disputed",
    resolved_at: "2026-09-04T14:21:07Z",
    resolved_by: "witness",
    days_estimated: 11.4,
    days_actual: 10.2,
    slip_ratio: 0.895,
    unchanged_since_commitment: false,
    censored: false,
  },
  attestations: [
    {
      witness_ref: "3f6a4c11-0f21-4f5b-9c7e-000000000001",
      verdict: "disputes",
      note: "The tag exists but points at an empty release; nothing was actually shipped.",
      signed_at: "2026-09-05T08:11:00Z",
      ledger_seq: 84730,
    },
  ],
  ledger: ledger(84731, hex("prev/84730"), hex("payload/84731")),
};

/**
 * §2.1 violated: `kept` claiming `withdrawal`. Correctly signed on purpose — a verifier that
 * only ever rejects this because the signature broke is not enforcing the pairing rule, and
 * the pairing rule is the no-self-report invariant in wire form.
 */
const invalidPairing: Json = {
  ...kept,
  commitment: { ...(kept.commitment as Json), id: "01843b2f-1c9a-4a2e-8f30-000000000005" },
  outcome: { ...(kept.outcome as Json), resolved_by: "withdrawal" },
  ledger: ledger(84740, hex("prev/84739"), hex("payload/84740")),
};

// ---------------------------------------------------------------------------------------
// tampering
// ---------------------------------------------------------------------------------------

type Path = readonly (string | number)[];

function setPath(root: Json, path: Path, value: unknown): void {
  let node: unknown = root;
  for (const key of path.slice(0, -1)) {
    node = Array.isArray(node) ? node[key as number] : (node as Json)[key as string];
  }
  const last = path[path.length - 1];
  if (last === undefined) throw new Error("setPath: empty path");
  if (Array.isArray(node)) node[last as number] = value;
  else (node as Json)[last as string] = value;
}

interface Tamper {
  readonly name: string;
  readonly base: Json;
  readonly apply: (doc: Json) => void;
}

const change = (name: string, base: Json, path: Path, value: unknown): Tamper => ({
  name,
  base,
  apply: (doc) => {
    setPath(doc, path, value);
  },
});

/**
 * One entry per field of the §3 signed subset, plus the array-shape attacks that no
 * field-level change can express: dropping an observation and reordering a history.
 */
const TAMPERS: readonly Tamper[] = [
  change("commitment.id", kept, ["commitment", "id"], "01843b2f-1c9a-4a2e-8f30-0000000000ff"),
  change("commitment.handle", kept, ["commitment", "handle"], "someone-else"),
  change("commitment.claim", kept, ["commitment", "claim"], "v0.2 released, plus the whole roadmap"),
  change("commitment.committed_at", kept, ["commitment", "committed_at"], "2026-08-01T09:14:22Z"),
  change("commitment.deadline_original", kept, ["commitment", "deadline_original"], "2026-09-30T18:29:00Z"),
  change("commitment.deadline_effective", kept, ["commitment", "deadline_effective"], "2026-09-30T18:29:00Z"),
  change("commitment.visibility", kept, ["commitment", "visibility"], "unlisted"),
  change("commitment.cohort_slug", kept, ["commitment", "cohort_slug"], "ship-september"),

  change("done_spec.spec_version", kept, ["done_spec", "spec_version"], 2),
  change("done_spec.hash", kept, ["done_spec", "hash"], `sha256:${hex("done-spec/other")}`),
  change("done_spec.source", kept, ["done_spec", "source"], 'http("https://example.com").status == 200'),
  change("done_spec.probe_class", kept, ["done_spec", "probe_class"], "strong"),

  change("outcome.status", kept, ["outcome", "status"], "missed"),
  change("outcome.resolved_at", kept, ["outcome", "resolved_at"], "2026-09-01T14:21:07Z"),
  change("outcome.days_estimated", kept, ["outcome", "days_estimated"], 20),
  change("outcome.days_actual", kept, ["outcome", "days_actual"], 1.2),
  change("outcome.slip_ratio", kept, ["outcome", "slip_ratio"], 0.1),
  change("outcome.unchanged_since_commitment", kept, ["outcome", "unchanged_since_commitment"], true),

  change("ledger.entry_seq", kept, ["ledger", "entry_seq"], 84714),
  change("ledger.entry_hash", kept, ["ledger", "entry_hash"], `sha256:${hex("entry/other")}`),
  change("ledger.prev_hash", kept, ["ledger", "prev_hash"], `sha256:${hex("prev/other")}`),
  change("ledger.payload_sha256", kept, ["ledger", "payload_sha256"], `sha256:${hex("payload/other")}`),

  change("evidence.source", kept, ["evidence", 0, "source"], "github:release:someone/else"),
  change("evidence.observed_at", kept, ["evidence", 0, "observed_at"], "2026-09-01T14:21:07Z"),
  change("evidence.resolved_ip", kept, ["evidence", 0, "resolved_ip"], "127.0.0.1"),
  change("evidence.status", kept, ["evidence", 0, "status"], 201),
  change("evidence.headers", kept, ["evidence", 0, "headers"], { "content-type": "text/plain" }),
  change("evidence.body_sha256", kept, ["evidence", 0, "body_sha256"], `sha256:${hex("body/other")}`),
  change("evidence.body_bytes", kept, ["evidence", 0, "body_bytes"], 3313),
  change("evidence.matches", kept, ["evidence", 0, "matches"], [{ op: "matches", pattern: "v0.2.*", value: "v0.2.9" }]),

  change("amendments.kind", amended, ["amendments", 0, "kind"], "abandoned"),
  change("amendments.old_value", amended, ["amendments", 0, "old_value"], "2026-08-20T18:29:00Z"),
  change("amendments.new_value", amended, ["amendments", 0, "new_value"], "2026-09-02T18:29:00Z"),
  change("amendments.reason", amended, ["amendments", 0, "reason"], "No reason given."),
  change("amendments.created_at", amended, ["amendments", 0, "created_at"], "2026-08-26T10:02:11Z"),
  change("amendments.ledger_seq", amended, ["amendments", 0, "ledger_seq"], 84691),

  change("attestations.witness_ref", disputed, ["attestations", 0, "witness_ref"], "3f6a4c11-0f21-4f5b-9c7e-0000000000ff"),
  change("attestations.verdict", disputed, ["attestations", 0, "verdict"], "confirms"),
  change("attestations.note", disputed, ["attestations", 0, "note"], "Looks fine to me."),
  change("attestations.signed_at", disputed, ["attestations", 0, "signed_at"], "2026-09-06T08:11:00Z"),
  change("attestations.ledger_seq", disputed, ["attestations", 0, "ledger_seq"], 84729),

  {
    name: "evidence.dropped",
    base: missedCensored,
    apply: (doc) => {
      // Removing the observation that could not see the target — the tidied record.
      (doc.evidence as unknown[]).splice(0, 1);
    },
  },
  {
    name: "amendments.reordered",
    base: amended,
    apply: (doc) => {
      (doc.amendments as unknown[]).reverse();
    },
  },
  {
    name: "signature.value",
    base: kept,
    apply: (doc) => {
      const signature = doc.signature as Json;
      const value = signature.value as string;
      // Flip one character of the signature, keeping it decodable base64url.
      signature.value = (value[0] === "A" ? "B" : "A") + value.slice(1);
    },
  },
  {
    name: "signature.public_key",
    base: kept,
    apply: (doc) => {
      const signature = doc.signature as Json;
      signature.public_key = "MCowBQYDK2VwAyEAGb9ECWmEzf6FQbrBZ9w7lshQhqowtrbLDFw4rXAxZuE=";
    },
  },
];

// `outcome.resolved_by` needs a value that is BOTH different and legal for `kept`, and §2.1
// allows only `probe` there. So the tamper for that field moves the whole pairing to a legal
// one — `disputed` + `witness` — which changes two signed fields at once and is the honest way
// to cover it: any single-field change to resolved_by is caught by the pairing rule instead.
const RESOLVED_BY_TAMPER: Tamper = {
  name: "outcome.resolved_by",
  base: kept,
  apply: (doc) => {
    const outcome = doc.outcome as Json;
    outcome.status = "disputed";
    outcome.resolved_by = "witness";
  },
};

function write(name: string, document: Json): void {
  writeFileSync(join(HERE, name), `${JSON.stringify(document, null, 2)}\n`, "utf8");
}

function main(): void {
  const signed = {
    "kept.json": sign(kept),
    "missed-censored.json": sign(missedCensored),
    "amended.json": sign(amended),
    "disputed-witness.json": sign(disputed),
    "invalid-pairing.json": sign(invalidPairing),
  };
  for (const [name, document] of Object.entries(signed)) write(name, document);

  writeFileSync(join(HERE, "fixture-key.pub"), `${KEY.publicKeySpki}\n`, "utf8");

  rmSync(TAMPERED, { recursive: true, force: true });
  mkdirSync(TAMPERED, { recursive: true });

  const bases = new Map<Json, Json>([
    [kept, signed["kept.json"]],
    [amended, signed["amended.json"]],
    [disputed, signed["disputed-witness.json"]],
    [missedCensored, signed["missed-censored.json"]],
  ]);

  for (const tamper of [...TAMPERS, RESOLVED_BY_TAMPER]) {
    const source = bases.get(tamper.base);
    if (source === undefined) throw new Error(`no signed base for ${tamper.name}`);
    const document = structuredClone(source);
    tamper.apply(document);
    writeFileSync(
      join(TAMPERED, `${tamper.name}.json`),
      `${JSON.stringify(document, null, 2)}\n`,
      "utf8",
    );
  }

  console.log(`wrote ${Object.keys(signed).length} receipts and ${TAMPERS.length + 1} tampered variants`);
}

main();
