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

export interface WitnessInviteMailInput {
  readonly to: string;
  /** Who asked. The witness is doing a favour for a person, not for pledge. */
  readonly handle: string;
  readonly claim: string;
  /** Already rendered in the committer's zone. */
  readonly deadline: string;
  /** The full magic link, including the token. Goes in the mail and nowhere else. */
  readonly attestUrl: string;
  readonly commitmentUrl: string;
}

/**
 * The invitation. One of the two moments a witness ever hears from us — commit and outcome,
 * and nothing in between (product-overview.md §7). A witness is a social obligation, not a
 * support burden, and a reminder drip is how this feature would become spam.
 *
 * Two things this copy must say, and both are consent rather than decoration:
 *
 *  · what a witness CAN do — the honest ceiling is `disputed`. Someone told they can "verify"
 *    a commitment has been told something false (ADR-0006), and a witness who believes their
 *    click produces a green tick is being used as a rubber stamp.
 *  · that their address becomes public if they attest. That is the mitigation the whole
 *    accountless design rests on (security.md T-02), so it cannot be a surprise afterwards.
 */
export function sendWitnessInviteMail(input: WitnessInviteMailInput): void {
  const resend = resendClient();
  if (resend === undefined) {
    console.warn(
      `[mail] RESEND_API_KEY not configured — skipping witness invite to ${input.to} for ${input.commitmentUrl}`,
    );
    return;
  }

  void resend.emails
    .send({
      from: FROM,
      to: input.to,
      subject: `${input.handle} put this on the record and named you as a witness`,
      text: [
        `${input.handle} made this commitment publicly:`,
        "",
        input.claim,
        "",
        `Deadline: ${input.deadline}`,
        "",
        "The outcome is decided by an automated probe against a stated done-spec, not by you",
        "and not by them. You are not being asked to approve anything, and you cannot mark this",
        "as done — nobody can.",
        "",
        "What you can do is put your own account of it on the record. If you say something the",
        "probe contradicts, the commitment is permanently shown as contested rather than",
        "settled. That is the most a witness can do, on purpose.",
        "",
        "One click, no account needed:",
        input.attestUrl,
        "",
        `If you attest, your email address (${input.to}) is shown publicly next to your verdict,`,
        "permanently. That attribution is the point; do not attest if you would rather not be",
        "named. Doing nothing is a normal and complete answer.",
        "",
        "The link works once and expires in 14 days.",
        "",
        `The commitment: ${input.commitmentUrl}`,
      ].join("\n"),
    })
    .then((result) => {
      if (result.error !== null) {
        console.warn(
          `[mail] witness invite rejected for ${input.commitmentUrl}:`,
          result.error,
        );
      }
    })
    .catch((error: unknown) => {
      console.warn(`[mail] witness invite threw for ${input.commitmentUrl}:`, error);
    });
}

export interface WitnessOutcomeMailInput {
  readonly to: string;
  readonly handle: string;
  readonly claim: string;
  readonly status: string;
  readonly commitmentUrl: string;
  /** Omitted once the witness has attested, or once their link has expired. */
  readonly attestUrl?: string;
}

/**
 * The second and last ping. What the record now says, and — only if their link is still
 * unspent and unexpired — a way to add their account of it.
 */
export function sendWitnessOutcomeMail(input: WitnessOutcomeMailInput): void {
  const resend = resendClient();
  if (resend === undefined) {
    console.warn(
      `[mail] RESEND_API_KEY not configured — skipping witness ${input.status} notice to ${input.to} for ${input.commitmentUrl}`,
    );
    return;
  }

  const tail =
    input.attestUrl === undefined
      ? ["Nothing is being asked of you.", "", `The record: ${input.commitmentUrl}`]
      : [
          "You were named as a witness. Your link is still good if you want to put your own",
          "account of this on the record:",
          input.attestUrl,
          "",
          "Doing nothing is a normal and complete answer.",
          "",
          `The record: ${input.commitmentUrl}`,
        ];

  void resend.emails
    .send({
      from: FROM,
      to: input.to,
      subject: `Resolved ${input.status}: ${input.claim}`,
      text: [
        `A probe resolved ${input.handle}'s commitment ${input.status}.`,
        "",
        input.claim,
        "",
        describe(input.status),
        "",
        ...tail,
      ].join("\n"),
    })
    .then((result) => {
      if (result.error !== null) {
        console.warn(
          `[mail] witness outcome rejected for ${input.commitmentUrl}:`,
          result.error,
        );
      }
    })
    .catch((error: unknown) => {
      console.warn(`[mail] witness outcome threw for ${input.commitmentUrl}:`, error);
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
