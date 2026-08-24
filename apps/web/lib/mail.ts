/**
 * Commit mail via Resend.
 *
 * Never awaited by a request handler and never inside the commit transaction: nothing in the
 * notification path may affect resolution or block a write (architecture.md §8). A send that
 * fails is a logged warning, never a failed commitment.
 *
 * A missing or placeholder RESEND_API_KEY degrades to a log line. Local dev and preview run on
 * placeholders and must still complete the loop end to end.
 */
import { Resend } from "resend";

const FROM = "pledge <record@pledge.sh>";

/** Resend keys start `re_`. Anything else is the .env.example placeholder or an empty string. */
function resendClient(): Resend | undefined {
  const key = process.env["RESEND_API_KEY"];
  return key !== undefined && key.startsWith("re_") ? new Resend(key) : undefined;
}

export interface CommitMailInput {
  readonly to: string;
  readonly handle: string;
  readonly claim: string;
  /** Already rendered in the committer's zone — this module does no date maths. */
  readonly deadline: string;
  readonly url: string;
}

/**
 * Fire-and-forget. Returns immediately; the send settles on its own and reports failures to
 * the log.
 *
 * ponytail: not a pg-boss job. v0 has no notification consumer in apps/worker, so a queued
 * mail would sit undrained. Move it onto the queue when retries actually matter — the call
 * site does not change.
 */
export function sendCommitMail(input: CommitMailInput): void {
  const resend = resendClient();
  if (resend === undefined) {
    console.warn(
      `[mail] RESEND_API_KEY not configured — skipping commit mail to ${input.to} for ${input.url}`,
    );
    return;
  }

  void resend.emails
    .send({
      from: FROM,
      to: input.to,
      // Past tense, record-first (ADR-0009). Not "you promised", not "good luck".
      subject: `On the record: ${input.claim}`,
      text: [
        `${input.handle} — this is now on the record.`,
        "",
        input.claim,
        "",
        `Deadline: ${input.deadline}`,
        "",
        "The outcome will be resolved by a probe against the done-spec you set. You cannot",
        "report it yourself, and neither can we.",
        "",
        input.url,
      ].join("\n"),
    })
    .then((result) => {
      if (result.error !== null) {
        console.warn(`[mail] commit mail rejected for ${input.url}:`, result.error);
      }
    })
    .catch((error: unknown) => {
      console.warn(`[mail] commit mail threw for ${input.url}:`, error);
    });
}

export interface ResolutionMailInput {
  readonly to: string;
  readonly handle: string;
  readonly claim: string;
  /** The commitment's status as stored, read back from the row rather than from the job. */
  readonly status: string;
  readonly url: string;
}

/**
 * What the record now says. Sent by the app tier draining `notify.resolution` — the probe
 * worker cannot send it, because it cannot read an email address (architecture.md §4).
 *
 * Copy rules, and they are not decoration: this says what was **observed**, never what was
 * "shipped" — that distinction is the whole trust argument. No congratulation on a `kept`, no
 * admonishment on a `missed`; the record is the product and it does not have opinions.
 */
export function sendResolutionMail(input: ResolutionMailInput): void {
  const resend = resendClient();
  if (resend === undefined) {
    console.warn(
      `[mail] RESEND_API_KEY not configured — skipping ${input.status} notice to ${input.to} for ${input.url}`,
    );
    return;
  }

  void resend.emails
    .send({
      from: FROM,
      to: input.to,
      subject: `Resolved ${input.status}: ${input.claim}`,
      text: [
        `${input.handle} — a probe resolved this commitment ${input.status}.`,
        "",
        input.claim,
        "",
        describe(input.status),
        "",
        "The done-spec and every probe run behind this are on the commitment page:",
        input.url,
      ].join("\n"),
    })
    .then((result) => {
      if (result.error !== null) {
        console.warn(`[mail] resolution mail rejected for ${input.url}:`, result.error);
      }
    })
    .catch((error: unknown) => {
      console.warn(`[mail] resolution mail threw for ${input.url}:`, error);
    });
}

/** One line of plain fact per status. `disputed` is the one that needs explaining. */
function describe(status: string): string {
  switch (status) {
    case "kept":
      return "The done-condition was observed to hold before the deadline.";
    case "missed":
      return "At the deadline, the done-condition was observed not to hold.";
    case "disputed":
      return [
        "The target could not be observed at the deadline, so nothing was concluded.",
        "This is not a miss. A probe that could not reach the target never becomes one.",
      ].join("\n");
    default:
      return `The commitment is now ${status}.`;
  }
}
