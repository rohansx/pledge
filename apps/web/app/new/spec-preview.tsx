"use client";

/**
 * What the spec you just wrote actually says, computed in the browser by `@pledge/spec`.
 *
 * This is why invariant I-6 exists. The same package the worker evaluates with and the same
 * package `npx pledge-verify` re-hashes with runs here, on every keystroke, with no round trip
 * — so the hash shown under the textarea is not a preview of the hash, it is the hash, derived
 * by the same code from the same bytes.
 *
 * Four things are on the record before you can commit, and each of them is here because
 * discovering it afterwards is expensive:
 *
 *   the canonical source   what you are promising, after canonicalisation (§5.1). Not the
 *                          friendly label of the template — the sentence the probe evaluates.
 *   the comparison mode    §4.1's footgun, stated as a consequence rather than a mode name.
 *   the probe class        §7, including "does not count toward calibration".
 *   the content address    §5 step 7. The hash IS the contract (CLAUDE.md I-4).
 */
import { compile, type SpecIssue } from "@pledge/spec";
import { PROBE_CLASS_NOTE, describeComparison, versionComparisons } from "./spec-source";

export type CompileResult = ReturnType<typeof compile>;

export interface SpecPreviewProps {
  readonly result: CompileResult;
  /**
   * A template with blanks still empty. Its expansion does not parse — the placeholder is not
   * a value — but reporting that as a parse error would greet everyone with a red panel before
   * they have typed anything, and an error you are shown before you can have caused it is an
   * error people learn to ignore.
   */
  readonly pending?: boolean;
}

export function SpecPreview({ result, pending = false }: SpecPreviewProps) {
  if (pending) {
    return (
      <section className="preview" aria-live="polite">
        <h2 className="preview-title">What you are promising</h2>
        <p className="field-hint">
          Fill in the blanks above and the exact done-spec appears here, with the hash it will
          be stored under, before you commit to it.
        </p>
      </section>
    );
  }

  if (!result.ok) {
    return (
      <section className="preview preview-bad" aria-live="polite">
        <h2 className="preview-title">This does not parse yet</h2>
        <ul className="preview-issues">
          {result.issues.map((issue, i) => (
            // Issues have no stable identity; the list is re-rendered whole on every keystroke
            // and never reordered in place, so the index is the honest key here.
            <li key={i}>{issueText(issue)}</li>
          ))}
        </ul>
      </section>
    );
  }

  const { spec } = result;
  const comparisons = versionComparisons(spec.ast);

  return (
    <section className="preview" aria-live="polite">
      <h2 className="preview-title">What you are promising</h2>
      <code className="spec block">{spec.dslSource}</code>

      {spec.warnings.map((warning, i) => (
        <p key={i} className="preview-warn">
          {warning.message}
        </p>
      ))}

      {comparisons.length === 0 ? null : (
        <dl className="preview-facts">
          {comparisons.map((comparison, i) => (
            <div key={i}>
              <dt>Version comparison</dt>
              <dd>{describeComparison(comparison)}</dd>
            </div>
          ))}
        </dl>
      )}

      <dl className="preview-facts">
        <div>
          <dt>Probe class</dt>
          <dd>
            <strong>{spec.probeClass}</strong> — {PROBE_CLASS_NOTE[spec.probeClass]}
          </dd>
        </div>
        <div>
          <dt>Content address</dt>
          {/* The hash of the canonical form, not of what was typed. Two specs that mean the
              same thing land on this same value, which is what makes it a contract rather
              than a checksum. */}
          <dd>
            <code className="hash">{spec.hash}</code>
          </dd>
        </div>
      </dl>
    </section>
  );
}

/**
 * Offsets are 0-based into the authored source; readers count from 1. Issues raised about the
 * spec as a whole rather than about a token carry -1 and get no position at all, because
 * "character 0" would send someone hunting at the wrong end of the line.
 */
function issueText(issue: SpecIssue): string {
  return issue.offset < 0 ? issue.message : `${issue.message} (character ${issue.offset + 1})`;
}
