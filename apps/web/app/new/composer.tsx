"use client";

/**
 * The composer. Under a minute to complete, which is the only requirement it has beyond being
 * correct: nothing in this architecture reduces the friction of the commit ritual, and that is
 * the most likely reason the product fails (architecture.md §13).
 *
 * NO FORECAST. The inline "38% chance" while the date picker is open is the behavioural
 * intervention and it is v2 — it needs `calibration_fit`, which does not exist (roadmap.md
 * deferred list). Do not stub it; a fake probability on a product about honest records is
 * worse than none.
 *
 * Validation is `CommitmentInputSchema`, the same object the route handler parses. This pass
 * exists to put messages next to fields; the server's pass is the control.
 */
import { probeKinds, type ProbeKind } from "@pledge/db/types";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import {
  CLAIM_MAX,
  CommitmentInputSchema,
  toFieldErrors,
  type CreatedCommitment,
  type FieldErrors,
} from "@/lib/commitment-input";

const KIND_LABEL: Record<ProbeKind, string> = {
  http_status: "A URL returns a status code",
  github_release_tag: "A GitHub release tag exists",
};

/** The reader's zone, read once. The server has no reliable way to infer it (see the schema). */
function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export function Composer() {
  const router = useRouter();

  const [claim, setClaim] = useState("");
  const [kind, setKind] = useState<ProbeKind>("github_release_tag");
  const [url, setUrl] = useState("https://");
  const [expectedStatus, setExpectedStatus] = useState("200");
  const [repo, setRepo] = useState("");
  const [tagPattern, setTagPattern] = useState("v*");
  const [deadlineDate, setDeadlineDate] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [submitting, setSubmitting] = useState(false);

  const timeZone = useMemo(browserTimeZone, []);

  const buildInput = () => ({
    claim,
    spec:
      kind === "http_status"
        ? { kind, url, expectedStatus: Number(expectedStatus) }
        : { kind, repo, tagPattern },
    deadlineDate,
    timeZone,
  });

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrors({});

    const parsed = CommitmentInputSchema.safeParse(buildInput());
    if (!parsed.success) {
      setErrors(toFieldErrors(parsed.error));
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch("/api/v1/commitments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(parsed.data),
      });

      if (!response.ok) {
        // The server re-validates; if it disagrees with the client pass, the server is right
        // and its field errors replace ours.
        const body: unknown = await response.json().catch(() => null);
        setErrors(readServerErrors(body));
        return;
      }

      const created = (await response.json()) as CreatedCommitment;
      router.push(`/c/${created.id}`);
    } catch (error: unknown) {
      setErrors({ _: [error instanceof Error ? error.message : "Could not reach the server"] });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="composer" onSubmit={onSubmit} noValidate>
      <FieldError errors={errors["_"]} />

      <label className="field">
        <span className="field-label">What are you committing to?</span>
        <input
          name="claim"
          value={claim}
          maxLength={CLAIM_MAX}
          onChange={(e) => {
            setClaim(e.target.value);
          }}
          placeholder="Ship pledge v0"
          autoFocus
        />
        <span className="field-hint">
          Prose, for readers. The done-spec below is what actually decides the outcome.
        </span>
        <FieldError errors={errors["claim"]} />
      </label>

      <fieldset className="field">
        <legend className="field-label">How will it be checked?</legend>
        <div className="radio-row">
          {probeKinds.map((k) => (
            <label key={k} className="radio">
              <input
                type="radio"
                name="kind"
                value={k}
                checked={kind === k}
                onChange={() => {
                  setKind(k);
                }}
              />
              {KIND_LABEL[k]}
            </label>
          ))}
        </div>

        {kind === "github_release_tag" ? (
          <>
            <label className="field">
              <span className="field-label">Repository</span>
              <input
                name="spec.repo"
                value={repo}
                onChange={(e) => {
                  setRepo(e.target.value);
                }}
                placeholder="owner/name"
                spellCheck={false}
              />
              <FieldError errors={errors["spec.repo"]} />
            </label>
            <label className="field">
              <span className="field-label">Tag pattern</span>
              <input
                name="spec.tagPattern"
                value={tagPattern}
                onChange={(e) => {
                  setTagPattern(e.target.value);
                }}
                placeholder="v0.1.*"
                spellCheck={false}
              />
              <span className="field-hint">
                A glob. <code>*</code> is the only wildcard — not a regular expression.
              </span>
              <FieldError errors={errors["spec.tagPattern"]} />
            </label>
          </>
        ) : (
          <>
            <label className="field">
              <span className="field-label">URL</span>
              <input
                name="spec.url"
                type="url"
                value={url}
                onChange={(e) => {
                  setUrl(e.target.value);
                }}
                placeholder="https://example.com/changelog"
                spellCheck={false}
              />
              <span className="field-hint">https only.</span>
              <FieldError errors={errors["spec.url"]} />
            </label>
            <label className="field">
              <span className="field-label">Expected status</span>
              <input
                name="spec.expectedStatus"
                type="number"
                min={100}
                max={599}
                value={expectedStatus}
                onChange={(e) => {
                  setExpectedStatus(e.target.value);
                }}
              />
              <FieldError errors={errors["spec.expectedStatus"]} />
            </label>
          </>
        )}
      </fieldset>

      <label className="field">
        <span className="field-label">Deadline</span>
        {/* Native date input: no picker dependency, and it already speaks the browser's
            locale and calendar. The value is a calendar day; the zone travels beside it. */}
        <input
          name="deadlineDate"
          type="date"
          value={deadlineDate}
          onChange={(e) => {
            setDeadlineDate(e.target.value);
          }}
        />
        <span className="field-hint">
          End of that day in {timeZone}. Stored as the exact instant it resolves against.
        </span>
        <FieldError errors={errors["deadlineDate"]} />
        <FieldError errors={errors["timeZone"]} />
      </label>

      <p className="note">
        Once this is created, neither you nor pledge can mark it done. A probe against the
        done-spec above is the only thing that resolves it, and the result — either way — is
        public.
      </p>

      <button type="submit" disabled={submitting}>
        {submitting ? "Recording…" : "Put it on the record"}
      </button>
    </form>
  );
}

function FieldError({ errors }: { errors?: readonly string[] }) {
  if (errors === undefined || errors.length === 0) return null;
  return (
    <span className="field-error" role="alert">
      {errors.join(". ")}
    </span>
  );
}

/** The route handler's 400 body: `{ error, fields? }`. Anything else becomes one message. */
function readServerErrors(body: unknown): FieldErrors {
  if (typeof body !== "object" || body === null) {
    return { _: ["The server rejected this commitment"] };
  }
  const record = body as Record<string, unknown>;
  const fields = record["fields"];
  if (typeof fields === "object" && fields !== null) return fields as FieldErrors;
  return { _: [typeof record["error"] === "string" ? record["error"] : "Rejected"] };
}
