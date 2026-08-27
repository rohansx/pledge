/**
 * What the amendment form submits. ONE schema, both sides — the form renders its messages,
 * the route handler enforces it (technical-spec §9, same arrangement as CommitmentInputSchema).
 *
 * `reason` is REQUIRED, and that is a product rule before it is a validation rule
 * (architecture.md §5.1): a deadline that moves without a stated reason is the silent
 * revision the ledger exists to prevent. It is enforced here, again by the route handler
 * parsing this same schema, and a third time by the `amendment_reason_not_blank` CHECK.
 *
 * INVARIANT I-4 COROLLARY: there is no `spec` field and there never will be. An amendment
 * moves when a commitment resolves; it never changes what was promised. Editing the spec is a
 * new hash and therefore a different commitment.
 */
import type { AmendmentRow } from "@pledge/db";
import { z } from "zod";
import { isValidTimeZone } from "./deadline";

/**
 * The two amendment kinds, taken from the column's own type rather than restated.
 *
 * `import type` — erased at compile time, so this file still bundles for the browser and no
 * part of postgres.js follows it in (the arrangement commitment-input.ts documents). The
 * canonical list lives in @pledge/ledger, which apps/web has no dependency edge to; going
 * through the row type is what keeps this a derivation instead of a copy.
 */
export type AmendmentKind = AmendmentRow["kind"];

export const amendmentKinds = [
  "deadline_moved",
  "abandoned",
] as const satisfies readonly AmendmentKind[];

/** Matches `AmendedPayloadSchema.reason` in @pledge/ledger, which is what gets hashed. */
export const REASON_MAX = 2000;
export const REASON_MIN = 3;

const reason = z
  .string()
  .trim()
  .min(REASON_MIN, "Say why. The reason is part of the record.")
  .max(REASON_MAX);

export const AmendmentInputSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("deadline_moved"),
    /**
     * A calendar day in the committer's zone, resolved to that day's last instant exactly the
     * way the original deadline was (CLAUDE.md I-9). Reusing the same path is the point: an
     * amended deadline that used different arithmetic from the original would be a different
     * kind of instant wearing the same name.
     */
    deadlineDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a date"),
    timeZone: z.string().min(1).max(64).refine(isValidTimeZone, "Unrecognised time zone"),
    reason,
  }),
  z.object({
    kind: z.literal("abandoned"),
    reason,
  }),
]);

export type AmendmentInput = z.infer<typeof AmendmentInputSchema>;

/**
 * Past tense, stating what happened. No softening: "withdrew" is what withdrawing is, and
 * "paused" or "rescheduled" would be the encouragement copy ADR-0009 rules out.
 *
 * Keyed by the column's union, so a new kind in @pledge/ledger fails this file to compile
 * rather than rendering as a blank label.
 */
export const AMENDMENT_LABEL: Record<AmendmentKind, string> = {
  deadline_moved: "Deadline moved",
  abandoned: "Withdrawn",
};

/** What POST .../amendments returns on success. */
export interface RecordedAmendment {
  readonly amendmentId: string;
  readonly ledgerSeq: number;
  /** The commitment's deadline after the amendment, ISO. Unchanged by a withdrawal. */
  readonly deadline: string;
}
