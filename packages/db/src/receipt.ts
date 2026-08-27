/**
 * The receipt builder — docs/spec/receipt-format.md §2, §3.
 *
 * WHY THIS LIVES IN @pledge/db AND NOT IN packages/verify OR apps/web
 * -------------------------------------------------------------------
 * Building a receipt needs the database and the signing key; verifying one must need neither.
 * Putting the builder in `pledge-verify` would drag Postgres and `PLEDGE_SIGNING_KEY` into the
 * package whose entire value is that a stranger can run it with no credentials, so the split
 * is the deliverable, not an accident of layout.
 *
 * That leaves @pledge/db or apps/web, and apps/web is not eligible: a receipt document
 * contains `status: "kept"` as a literal, and scripts/check-invariants.mjs fails the build on
 * exactly that shape anywhere under apps/web (CLAUDE.md I-1). The check is right to — the
 * pattern it looks for cannot distinguish "assembling a document that reports a resolution"
 * from "writing a resolution" — and weakening it to make room for a builder would trade the
 * product's core guarantee for a file's convenience. So: here, where the rows already are,
 * and apps/web gets a one-line call when it wants to serve one.
 *
 * The builder READS. It never writes, never resolves, never touches the ledger. A receipt is a
 * projection of records that already exist; if a fact is not in the database, it is not in the
 * receipt.
 *
 * WHAT IS SIGNED COMES FROM pledge-verify (`signedSubset`), not from a second local copy of
 * §3. Two implementations of the signed subset would drift, and the drift would surface as a
 * stranger's verifier reporting FORGED against a receipt we consider valid. Same reasoning as
 * `computeEntry` in @pledge/ledger: one implementation, two consumers.
 */
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { signValue, type SigningKey } from "@pledge/ledger";
import { classify, compile, print, quote, SPEC_VERSION, type ProbeClass } from "@pledge/spec";
import {
  RECEIPT_FORMAT,
  RECEIPT_SIGNING_CONTEXT,
  ReceiptBodySchema,
  signedSubset,
  type Receipt,
  type ReceiptBody,
} from "pledge-verify";
import type { DbOrTx } from "./client";
import {
  account,
  amendment,
  commitment,
  doneSpec,
  ledgerEntry,
  probeRun,
  witness,
  witnessAttestation,
} from "./schema";
import type { DoneSpecV0, ProbeEvidence, StoredDoneSpec } from "./types";

const DAY_MS = 86_400_000;

export interface BuildReceiptOptions {
  /** §2.1: informational only, and a conforming verifier MUST NOT fetch it (§4.1). */
  readonly issuer?: string;
  /** Defaults to the service key from `PLEDGE_SIGNING_KEY`. */
  readonly key?: SigningKey;
}

/** §2.1: all hashes are `<alg>:<lowercase-hex>`. Stored columns are bare hex. */
const hashRef = (hex: string): string => `sha256:${hex}`;

/** Deterministic. JCS emits ECMAScript number syntax exactly, so what rounds here is what signs. */
const round = (value: number, places: number): number => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

/**
 * The two things the receipt needs about a spec that the row does not store: the canonical
 * source text, and the probe class.
 *
 * A v1 spec already IS an AST, so both come straight from @pledge/spec — `print` is the fixed
 * point of §5.1, i.e. the same bytes the composer showed the committer and the same bytes a
 * verifier re-hashes to the stored `done_spec.hash`.
 *
 * A v0 spec has no source text ever authored by anyone, so one is rendered and then compiled —
 * see below.
 *
 * Two things come back that the v0 tables do not store: the canonical source text a reader
 * needs to judge the criterion (§1 — never a badge without its spec), and `probe_class`,
 * which ADR-0007 requires be derived from the AST rather than from anything a committer typed.
 * Deriving it through the real classifier means the receipt's class is the same function the
 * rest of the system uses, not a lookup table that can quietly disagree with it.
 *
 * The receipt's `done_spec.hash` is NOT this source's hash. It is the stored v0 hash, over the
 * v0 canonical JSON, which is what the commitment is actually bound to (CLAUDE.md I-4);
 * `spec_version: 0` in the receipt is what tells a verifier which canonical form that hash is
 * over. Recomputing a spec hash from `source` is only meaningful for spec_version 1 and is
 * deliberately not attempted here or in the verifier.
 */
function describe(
  spec: StoredDoneSpec,
  specVersion: number,
): { readonly source: string; readonly probeClass: ProbeClass } {
  if (specVersion === SPEC_VERSION) {
    // No round trip through the parser: the AST is the authored artefact, `print` is its
    // canonical rendering, and re-parsing what we just printed would only be able to tell us
    // something new if `print` were wrong — in which case the composer showed the committer
    // the wrong thing too, and packages/spec's round-trip property test is the place that
    // fails, not here.
    const ast = spec as Exclude<StoredDoneSpec, DoneSpecV0>;
    return { source: print(ast), probeClass: classify(ast) };
  }
  if (specVersion !== 0) {
    throw new Error(`buildReceipt: spec_version ${specVersion} is not one this build can describe`);
  }
  const v0 = spec as DoneSpecV0;
  const source =
    v0.kind === "http_status"
      ? `http(${quote(v0.url)}).status == ${v0.expectedStatus}`
      : `github.release(${quote(v0.repo)}).tag matches ${quote(v0.tagPattern)}`;

  const compiled = compile(source);
  if (!compiled.ok) {
    // A receipt with an invented probe class is worse than no receipt: it is a signed claim
    // about how demanding the criterion was, made up by the code that could not read it.
    throw new Error(
      `buildReceipt: the stored spec does not render to valid DSL (${compiled.issues.map((i) => i.code).join(", ")})`,
    );
  }
  return { source: compiled.spec.dslSource, probeClass: compiled.spec.probeClass };
}

/**
 * The stable identifier of the target a v0 probe observed.
 *
 * v0 only. A v1 run records one `source` key per observation, in AST source order, and those
 * are used verbatim — §3 requires `evidence` in canonical AST source order, and inventing a
 * label for a multi-source run would put a name on the receipt that the spec never used.
 */
const evidenceSource = (spec: StoredDoneSpec): string => {
  if (spec.kind === "http_status") return `http:${spec.url}`;
  if (spec.kind === "github_release_tag") return `github:release:${spec.repo}`;
  // Unreachable: a v1 row goes down the observations path below.
  throw new Error("buildReceipt: a v1 spec has no single evidence source");
};

/**
 * The v1 evidence shape, read back out of `probe_run.evidence` jsonb.
 *
 * Zod and not a cast: this is a read of a jsonb column, i.e. a trust boundary, and the writer
 * lives in another package (apps/worker/src/spec-probe.ts) whose types this one cannot see.
 * A v0 row simply has no `observations` key and takes the single-entry path below.
 *
 * Loose objects on purpose. The worker's evidence carries `subresults`, `targetDigest` and
 * more; a strict schema here would make every future field the worker records a build break in
 * a package that does not care about it.
 */
const SpecObservationsSchema = z.object({
  observations: z.array(
    z.object({
      source: z.string().min(1),
      observedAt: z.string().min(1),
      evidence: z
        .object({
          status: z.number().optional(),
          headers: z.record(z.string(), z.string()).optional(),
          bodySha256: z.string().optional(),
          bodyBytes: z.number().optional(),
          resolvedIp: z.string().optional(),
        })
        .optional(),
    }),
  ),
});

/**
 * One run → its evidence entries, in canonical AST source order (§3).
 *
 * A v1 run observed one source per entry of `observations`, and each is its own row in the
 * receipt: a multi-source spec that collapsed to one entry would have to pick a winner, and
 * the entry it dropped is exactly the one a sceptical reader wants.
 *
 * `matches` is `[]` for a v1 observation. Per-source evidence records what came back, not what
 * it meant; the comparison outcomes live in the run's `subresults`, and the receipt format has
 * no field for those. Emitting an empty list is the accurate statement — inventing match
 * records here would be a signed claim assembled by the builder.
 *
 * `observed_at` comes from the OBSERVATION, not from `probe_run.ran_at`: a run's sources are
 * fetched at slightly different instants and the receipt says when each target answered.
 */
function evidenceEntries(
  evidence: ProbeEvidence,
  ranAt: Date,
  spec: StoredDoneSpec,
): readonly ReceiptBody["evidence"][number][] {
  const v1 = SpecObservationsSchema.safeParse(evidence);
  if (v1.success) {
    return v1.data.observations.map((observation) => ({
      source: observation.source,
      observed_at: new Date(observation.observedAt).toISOString(),
      resolved_ip: observation.evidence?.resolvedIp ?? null,
      status: observation.evidence?.status ?? null,
      headers: observation.evidence?.headers ?? {},
      body_sha256:
        observation.evidence?.bodySha256 === undefined
          ? null
          : hashRef(observation.evidence.bodySha256),
      body_bytes: observation.evidence?.bodyBytes ?? null,
      matches: [],
    }));
  }

  return [
    {
      source: evidenceSource(spec),
      observed_at: ranAt.toISOString(),
      resolved_ip: evidence.resolvedIp ?? null,
      status: evidence.status ?? null,
      headers: evidence.headers ?? {},
      body_sha256: evidence.bodySha256 === undefined ? null : hashRef(evidence.bodySha256),
      body_bytes: evidence.bodyBytes ?? null,
      matches: evidence.matches ?? [],
    },
  ];
}

/**
 * Assembles and signs the receipt for one resolved commitment.
 *
 * Throws for an unresolved commitment: a receipt asserts an outcome, and `open` is the absence
 * of one. Throws if the resolution has no ledger entry, which cannot happen (I-3 puts the
 * append in the resolving transaction) and is therefore worth failing loudly on rather than
 * papering over with a null.
 */
export async function buildReceipt(
  db: DbOrTx,
  commitmentId: string,
  options: BuildReceiptOptions = {},
): Promise<Receipt> {
  const [row] = await db
    .select({ commitment, spec: doneSpec.ast, specVersion: doneSpec.specVersion, handle: account.handle })
    .from(commitment)
    .innerJoin(account, eq(account.id, commitment.accountId))
    .innerJoin(doneSpec, eq(doneSpec.hash, commitment.doneSpecHash))
    .where(eq(commitment.id, commitmentId))
    .limit(1);

  if (row === undefined) throw new Error(`buildReceipt: no commitment ${commitmentId}`);

  const c = row.commitment;
  if (c.status === "open" || c.resolvedAt === null) {
    throw new Error(`buildReceipt: commitment ${commitmentId} is still open — there is no outcome to attest`);
  }

  // The entry the receipt points at: the most recent `resolved` entry for this commitment. A
  // dispute appends a second one, and the receipt describes the state as it stands.
  const [entry] = await db
    .select({
      seq: ledgerEntry.seq,
      entryHash: ledgerEntry.entryHash,
      prevHash: ledgerEntry.prevHash,
      payloadSha256: ledgerEntry.payloadSha256,
      payload: ledgerEntry.payload,
    })
    .from(ledgerEntry)
    .where(
      and(
        eq(ledgerEntry.entryType, "resolved"),
        sql`${ledgerEntry.payload}->>'commitmentId' = ${commitmentId}`,
      ),
    )
    .orderBy(desc(ledgerEntry.seq))
    .limit(1);

  if (entry === undefined) {
    throw new Error(`buildReceipt: commitment ${commitmentId} is ${c.status} with no 'resolved' ledger entry`);
  }

  const runs = await db
    .select()
    .from(probeRun)
    .where(eq(probeRun.commitmentId, commitmentId))
    .orderBy(asc(probeRun.ranAt), asc(probeRun.id));

  const amendments = await db
    .select()
    .from(amendment)
    .where(eq(amendment.commitmentId, commitmentId))
    .orderBy(asc(amendment.ledgerSeq));

  const attestations = await db
    .select({ attestation: witnessAttestation, witnessId: witness.id })
    .from(witnessAttestation)
    .innerJoin(witness, eq(witness.id, witnessAttestation.witnessId))
    .where(eq(witness.commitmentId, commitmentId))
    .orderBy(asc(witnessAttestation.ledgerSeq));

  const spec = row.spec;
  const described = describe(spec, row.specVersion);

  // The EARLIEST passing observation. §6: `days_actual` is null when a completion was never
  // observed — right-censored, not zero — so it is derived from whether a `pass` exists at all,
  // never from the resolution time of a `missed`. Reading a miss as "took zero days" is the
  // exact bias the censoring rule exists to prevent.
  const firstPass = runs.find((run) => run.outcome === "pass");
  const daysActual =
    firstPass === undefined
      ? null
      : round((firstPass.ranAt.getTime() - c.committedAt.getTime()) / DAY_MS, 2);

  const daysEstimated = c.estimatedDays === null ? null : round(Number(c.estimatedDays), 2);
  const slipRatio =
    daysActual === null || daysEstimated === null || daysEstimated === 0
      ? null
      : round(daysActual / daysEstimated, 3);

  // Same rule as `noveltyOf` in apps/web/lib/spec-display.ts, collapsed to the boolean §3
  // defines. The tri-state matters there because "we could not capture a baseline" must never
  // render as a clean bill of health; here `false` means "not known to be unchanged", which is
  // what §5.4 already says the flag is — a hint, not a proof.
  const unchanged =
    c.baselineSha256 !== null &&
    firstPass !== undefined &&
    firstPass.evidence.bodySha256 === c.baselineSha256;

  const status = c.status;

  // `resolved_by` is read from the ledger's own resolution payload rather than inferred from
  // the status. §2.1's pairing rule is only worth checking if this field reports what actually
  // happened; the payload schema in @pledge/ledger already refused every illegal pairing at
  // write time (ADR-0006), so this is a read of an enforced fact, not a guess.
  const resolvedByValue = (entry.payload as { readonly resolvedBy?: unknown }).resolvedBy;
  if (resolvedByValue !== "probe" && resolvedByValue !== "witness" && resolvedByValue !== "withdrawal") {
    throw new Error(`buildReceipt: ledger entry ${entry.seq} has no usable resolvedBy`);
  }

  const body: ReceiptBody = ReceiptBodySchema.parse({
    format: RECEIPT_FORMAT,
    issuer: options.issuer ?? "https://pledge.sh",
    commitment: {
      id: c.id,
      handle: row.handle,
      claim: c.claim,
      committed_at: c.committedAt.toISOString(),
      // `commitment.deadline` holds the CURRENT deadline; the original is the first amendment's
      // old value, because that column is overwritten by a move (schema.ts, amendment).
      deadline_original: (amendments.find((a) => a.kind === "deadline_moved")?.oldValue ??
        c.deadline.toISOString()) as string,
      deadline_effective: c.deadline.toISOString(),
      visibility: c.visibility,
      cohort_slug: null,
    },
    done_spec: {
      spec_version: row.specVersion,
      hash: hashRef(c.doneSpecHash),
      source: described.source,
      probe_class: described.probeClass,
    },
    outcome: {
      status,
      resolved_at: c.resolvedAt.toISOString(),
      resolved_by: resolvedByValue,
      days_estimated: daysEstimated,
      days_actual: daysActual,
      slip_ratio: slipRatio,
      unchanged_since_commitment: unchanged,
      censored: daysActual === null && (status === "missed" || status === "abandoned"),
    },
    amendments: amendments.map((a) => ({
      kind: a.kind,
      old_value: a.oldValue ?? null,
      new_value: a.newValue ?? null,
      reason: a.reason,
      created_at: a.createdAt.toISOString(),
      ledger_seq: a.ledgerSeq,
    })),
    // Every observation, including the ones that failed and the ones that observed nothing at
    // all. A receipt that showed only the run that resolved it would be a tidied record, and a
    // tidied record is what this product exists to be distinguishable from.
    evidence: runs.flatMap((run) => evidenceEntries(run.evidence, run.ranAt, spec)),
    attestations: attestations.map(({ attestation, witnessId }) => ({
      // The witness id, never the email. Receipts are public (ADR-0006, security.md T-02).
      witness_ref: witnessId,
      verdict: attestation.verdict,
      note: attestation.note,
      signed_at: attestation.signedAt.toISOString(),
      ledger_seq: attestation.ledgerSeq,
    })),
    ledger: {
      entry_seq: entry.seq,
      entry_hash: hashRef(entry.entryHash),
      prev_hash: hashRef(entry.prevHash),
      payload_sha256: hashRef(entry.payloadSha256),
    },
    // §5.3. Anchoring does not exist in v1 — there are no checkpoints and ADR-0005 is Proposed
    // — so this is the normal case, not an exception. `expected_anchor_by` is deliberately
    // omitted: promising a time for something no scheduled job performs would be a signed
    // statement that is not true.
    anchor: null,
    anchor_pending: true,
  } satisfies ReceiptBody);

  const signature = signValue(RECEIPT_SIGNING_CONTEXT, signedSubset(body), options.key);

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
