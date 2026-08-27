/**
 * The witness page. The only surface in pledge that a person with no account can act from
 * (ADR-0006).
 *
 * The exit criterion is "attest from a link in one click", so this page renders the whole
 * decision at once: what was claimed, what the probe actually checks, what the record currently
 * says, and two submit buttons. No JavaScript — a plain form post, because a witness on a
 * phone with a flaky connection is the median case and a hydration failure would be a silent
 * zero-completion feature.
 *
 * NOT INDEXED, and the URL carries a bearer secret, so:
 *   · `robots: noindex, nofollow`
 *   · `referrer: no-referrer` — without it the token leaks in the Referer header of every
 *     outbound link on the page.
 *   · `dynamic = 'force-dynamic'` — a cached render of one witness's page served to another
 *     would be a disclosure, and the page is per-token by construction.
 *
 * The copy tells the truth about the ceiling: a witness cannot mark anything as done. Telling
 * someone they can "verify" this would be a lie the product's whole architecture exists to
 * avoid, and a witness who thinks their click produces a green tick is a rubber stamp.
 */
import type { Metadata } from "next";
import { formatInZone } from "@/lib/deadline";
import { describeSpec } from "@/lib/spec-display";
import { WITNESS_NOTE_MAX } from "@/lib/witness-input";
import { getWitnessByTokenHash } from "@/lib/witness-queries";
import { parseWitnessToken, witnessTokenRefusal } from "@/lib/witness-token";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Witness — pledge",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

interface PageProps {
  params: Promise<{ token: string }>;
}

export default async function WitnessPage({ params }: PageProps) {
  const { token } = await params;

  // Signature and expiry first, offline. An invalid link never reaches the database, so
  // /w/<anything> is not a query amplifier.
  const parsed = parseWitnessToken(token);
  if (!parsed.ok) return <Refused />;

  const link = await getWitnessByTokenHash(parsed.tokenHash);
  if (link === undefined) return <Refused />;

  if (link.attestation !== undefined) {
    return (
      <main className="page narrow">
        <h1>Recorded</h1>
        <p className="lede">
          You said this commitment was{" "}
          {link.attestation.verdict === "confirms" ? "done" : "not done"}. That is now part of{" "}
          {link.handle}&rsquo;s permanent record, next to your address.
        </p>
        {link.attestation.note === null ? null : (
          <p className="note">{link.attestation.note}</p>
        )}
        <p className="muted">
          The link has been used and will not work again. Nothing further is needed from you.
        </p>
        <p>
          <a href={`/c/${link.commitmentId}`}>See the record</a>
        </p>
      </main>
    );
  }

  // Single-use is `used_at`, which is set even when the attestation insert is what spent it.
  // Belt to the braces above: a spent link with no attestation row should be impossible, and
  // if it happens the honest answer is the refusal, not a second form.
  if (link.usedAt !== null) return <Refused />;

  return (
    <main className="page narrow">
      <p className="crumb">{link.handle}</p>
      <h1>{link.claim}</h1>

      <p className="lede">
        {link.handle} put this on the record and named you as a witness. You are not approving
        anything.
      </p>

      <dl className="meta">
        <dt>Deadline</dt>
        <dd>{formatInZone(link.deadline, "UTC")} UTC</dd>
        <dt>Resolved by</dt>
        {/* The criterion, never hidden behind the outcome (security.md T-04). */}
        <dd>
          <code className="spec block">{describeSpec(link.spec)}</code>
        </dd>
        <dt>The record currently says</dt>
        <dd>{link.status}</dd>
      </dl>

      <p className="note">
        A probe decides whether this was done, not you and not {link.handle}. There is no button
        anywhere in pledge that marks something as kept. What your answer does is put your own
        account on the record: if it contradicts what the probe observed, this commitment is
        shown as contested from then on, permanently. That is the most a witness can do, by
        design.
      </p>

      <form className="composer" method="post" action="/api/v1/witness/attest">
        <input type="hidden" name="token" value={token} />

        <div className="field">
          <label className="field-label" htmlFor="note">
            Anything you want on the record (optional)
          </label>
          <textarea id="note" name="note" rows={3} maxLength={WITNESS_NOTE_MAX} />
          <span className="field-hint">Shown publicly, in your words, permanently.</span>
        </div>

        {/* One click. Two buttons, one form, no JavaScript, no confirmation step. */}
        <div className="radio-row">
          <button type="submit" name="verdict" value="confirms">
            As far as I know, this was done
          </button>
          <button type="submit" name="verdict" value="disputes">
            As far as I know, this was not done
          </button>
        </div>
      </form>

      <p className="muted">
        Attesting publishes your email address ({link.email}) next to your answer, permanently.
        That attribution is what makes a vouch mean anything — do not attest if you would rather
        not be named. Doing nothing is a complete answer and closes nothing.
      </p>
    </main>
  );
}

/**
 * One page for expired, spent, forged and unknown. The distinction is only useful to someone
 * probing for valid ids, and security.md T-02 says not to echo the secret back either.
 */
function Refused() {
  return (
    <main className="page narrow">
      <h1>Link not valid</h1>
      <p className="lede">{witnessTokenRefusal()}</p>
      <p className="muted">
        Witness links work once and expire after 14 days. If you still want to say something
        about this commitment, ask the person who invited you to send a new one.
      </p>
    </main>
  );
}
