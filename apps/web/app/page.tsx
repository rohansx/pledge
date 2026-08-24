import Link from "next/link";

/**
 * The landing page leads with the record, not the promise (ADR-0009, technical-spec §1.6).
 *
 * Words that do not appear here and must not be added: accountability, hold yourself, stay on
 * track, streak. The product is not a motivational tool and copy that borrows their vocabulary
 * borrows their claim.
 */
export default function HomePage() {
  return (
    <main className="page narrow">
      <h1 className="hero">The record of what you shipped.</h1>

      <p className="lede">
        A commitment is a claim, a machine-checkable done-spec, and a deadline. A probe against
        external state decides the outcome. You cannot mark your own work done — there is no
        endpoint for it, and the database role the website runs as cannot write one.
      </p>

      <ol className="how">
        <li>
          <strong>Commit.</strong> Say what you will do and state the condition a probe can
          check: a URL returning a status, or a GitHub release tag matching a pattern.
        </li>
        <li>
          <strong>Ship, or do not.</strong> Nothing nags you. Nothing asks how it is going.
        </li>
        <li>
          <strong>The probe looks.</strong> Kept and missed are both public, and the criterion
          is one click from every outcome.
        </li>
      </ol>

      <p>
        <Link className="cta" href="/new">
          Put something on the record
        </Link>
      </p>

      <p className="muted">
        A probe that could not reach its target records that it could not reach its target. It
        never counts as a miss.
      </p>
    </main>
  );
}
