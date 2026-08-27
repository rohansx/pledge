/**
 * The two shapes the witness endpoints accept. One schema per shape, shared by the route
 * handler and by whatever form submits to it — a second hand-written validator on either side
 * is a divergence waiting to happen (CLAUDE.md, Conventions).
 *
 * Browser-safe: Zod only, no Node import, so the composer can validate an invite list before
 * submitting it.
 */
import { z } from "zod";
import { witnessVerdicts } from "@pledge/ledger";

export const WITNESS_NOTE_MAX = 500;

/**
 * A witness feature is a favour someone does you, not a mailing list. Five is generous for the
 * "one or two people who would know" case ADR-0006 describes, and it caps how much mail one
 * commitment can generate.
 *
 * Lives here rather than beside the handler so the browser can read it without pulling
 * postgres.js in behind it (CLAUDE.md I-6, same reasoning one level up).
 */
export const MAX_WITNESSES_PER_COMMITMENT = 5;

export const WitnessInviteInputSchema = z.object({
  commitmentId: z.uuid(),
  /**
   * Addresses the committer typed. Never trusted as identity — the link proves possession of
   * an inbox and nothing more (ADR-0006, "identity assurance is weak"), which is exactly why a
   * witness cannot reach `kept`.
   */
  emails: z
    .array(z.email().max(320))
    .min(1, "Add at least one address")
    .max(MAX_WITNESSES_PER_COMMITMENT),
});

export type WitnessInviteInput = z.infer<typeof WitnessInviteInputSchema>;

export const WitnessAttestInputSchema = z.object({
  /** The magic-link token, verbatim from the URL. Verified before it reaches the database. */
  token: z.string().min(1).max(512),
  verdict: z.enum(witnessVerdicts),
  /**
   * The witness's own words, optional. Empty and whitespace-only collapse to null rather than
   * to `""` so the public record does not carry an empty quotation mark.
   */
  note: z
    .string()
    .max(WITNESS_NOTE_MAX)
    .transform((value) => {
      const trimmed = value.trim();
      return trimmed.length === 0 ? null : trimmed;
    })
    .nullable()
    .default(null),
});

export type WitnessAttestInput = z.infer<typeof WitnessAttestInputSchema>;
