/**
 * The single definition of what the composer submits.
 *
 * ONE schema, both sides (technical-spec §9). `app/new/composer.tsx` validates against it in
 * the browser to render field errors; `app/api/v1/commitments/route.ts` validates against it
 * again before anything reaches Drizzle (architecture.md §4, zone 1 → 2). The client-side pass
 * is a convenience, the server-side pass is the control — a second hand-written validator on
 * either side is a divergence waiting to happen.
 *
 * `DoneSpecV0Schema` is reused verbatim from @pledge/db/types rather than restated. That
 * module is types + Zod only and has no Node-only import, so it bundles for the browser
 * (CLAUDE.md I-6). Importing "@pledge/db" here instead would drag postgres.js into the client
 * bundle.
 */
import { DoneSpecV0Schema } from "@pledge/db/types";
import { z } from "zod";
import { isValidTimeZone } from "./deadline";

export const CLAIM_MAX = 280;

export const CommitmentInputSchema = z.object({
  /** What the committer says they will do. Prose — the done-spec is what actually decides. */
  claim: z.string().trim().min(3, "Say what you are committing to").max(CLAIM_MAX),

  /**
   * The machine-checkable condition. Content-addressed once hashed, and shown next to every
   * outcome — a badge whose criterion is not inspectable is the thing pledge replaces
   * (security.md T-04).
   */
  spec: DoneSpecV0Schema,

  /**
   * A calendar day, not an instant. The committer picks "5 September"; the server resolves it
   * to that day's last millisecond in `timeZone` (CLAUDE.md I-9).
   */
  deadlineDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a date"),

  /**
   * The committer's IANA zone, from `Intl.DateTimeFormat().resolvedOptions().timeZone`. Sent
   * explicitly rather than inferred server-side: the server's zone is UTC and guessing from a
   * UTC-offset header gets DST wrong twice a year.
   */
  timeZone: z.string().min(1).max(64).refine(isValidTimeZone, "Unrecognised time zone"),

  /** The committer's own estimate. Recorded for the v2 forecast; nothing reads it in v0. */
  estimatedDays: z.number().int().min(1).max(3650).optional(),
});

export type CommitmentInput = z.infer<typeof CommitmentInputSchema>;

/** What POST /api/v1/commitments returns on success. */
export interface CreatedCommitment {
  readonly id: string;
  readonly handle: string;
  readonly deadline: string;
  readonly doneSpecHash: string;
}

/** Field-keyed errors, the shape the composer renders. */
export type FieldErrors = Readonly<Record<string, readonly string[]>>;

/** Flattens a ZodError into `{ "spec.url": ["..."] }`. Dotted paths match the form's inputs. */
export function toFieldErrors(error: z.ZodError): FieldErrors {
  const out: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = issue.path.length === 0 ? "_" : issue.path.join(".");
    (out[key] ??= []).push(issue.message);
  }
  return out;
}
