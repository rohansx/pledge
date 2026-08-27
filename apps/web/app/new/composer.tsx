"use client";

/**
 * The composer. Under a minute to complete, which is the only requirement it has beyond being
 * correct: nothing in this architecture reduces the friction of the commit ritual, and that is
 * the most likely reason the product fails (architecture.md §13).
 *
 * It submits DSL source, not a form shape. The five templates are a way of writing that source
 * without learning the grammar — they are not a second, parallel way of saying what done means
 * — so there is exactly one thing that gets canonicalised, hashed and probed, and the user has
 * seen it before pressing the button (`./spec-preview.tsx`).
 *
 * NO FORECAST. The inline "38% chance" while the date picker is open is the behavioural
 * intervention and it is v2 — it needs `calibration_fit`, which does not exist (roadmap.md
 * deferred list). Do not stub it; a fake probability on a product about honest records is
 * worse than none.
 *
 * Validation is `CommitmentInputSchema`, the same object the route handler parses. This pass
 * exists to put messages next to fields; the server's pass is the control, and the server
 * re-compiles the source rather than trusting anything computed here.
 */
import { compile, getTemplate, isComplete, templateIds, type TemplateId } from "@pledge/spec";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import {
  CLAIM_MAX,
  CommitmentInputSchema,
  toFieldErrors,
  type CreatedCommitment,
  type FieldErrors,
} from "@/lib/commitment-input";
import { SpecEditor } from "./spec-editor";
import { SpecPreview } from "./spec-preview";

/** The reader's zone, read once. The server has no reliable way to infer it (see the schema). */
function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

const FIRST_TEMPLATE: TemplateId = templateIds[0];

export function Composer() {
  const router = useRouter();

  const [claim, setClaim] = useState("");
  const [templateId, setTemplateId] = useState<TemplateId>(FIRST_TEMPLATE);
  const [values, setValues] = useState<Readonly<Record<string, string>>>({});
  /** `null` while the templates are driving. A string once the user took the wheel. */
  const [raw, setRaw] = useState<string | null>(null);
  const [deadlineDate, setDeadlineDate] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [submitting, setSubmitting] = useState(false);

  const timeZone = useMemo(browserTimeZone, []);

  // One derivation, one source of truth. An unfilled blank expands to a placeholder that does
  // not parse, so "incomplete" and "invalid" reach the user through the same channel instead
  // of through a second completeness rule that could disagree with the parser.
  const source = useMemo(
    () => raw ?? getTemplate(templateId).expand(values),
    [raw, templateId, values],
  );
  const result = useMemo(() => compile(source), [source]);
  /** Blanks still to fill. Not an error yet — see SpecPreview's `pending`. */
  const pending = raw === null && !isComplete(getTemplate(templateId), values);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrors({});

    const parsed = CommitmentInputSchema.safeParse({
      claim,
      specSource: source,
      deadlineDate,
      timeZone,
    });
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
        // The server re-validates and re-compiles; if it disagrees with the client pass, the
        // server is right and its field errors replace ours.
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

      <SpecEditor
        templateId={templateId}
        values={values}
        raw={raw}
        source={source}
        onTemplate={setTemplateId}
        onValue={(name, value) => {
          setValues((current) => ({ ...current, [name]: value }));
        }}
        onRaw={setRaw}
      />
      <FieldError errors={errors["specSource"]} />

      <SpecPreview result={result} pending={pending} />

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

      <button type="submit" disabled={submitting || !result.ok}>
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
