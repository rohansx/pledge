"use client";

/**
 * The amendment form.
 *
 * Validation is `AmendmentInputSchema`, the same object the route handler parses. This pass
 * exists to put messages next to fields; the server's pass is the control.
 *
 * The reason field is not optional and is not pre-filled. A default reason would be a reason
 * nobody wrote, which is worse than no reason at all — it would make the history look
 * considered while saying nothing (architecture.md §5.1).
 */
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import {
  AmendmentInputSchema,
  REASON_MAX,
  type AmendmentKind,
} from "@/lib/amendment-input";
import { toFieldErrors, type FieldErrors } from "@/lib/commitment-input";

interface AmendFormProps {
  commitmentId: string;
  currentDeadlineIso: string;
  /** Server-rendered UTC rendering of the current deadline, for the no-JS/pre-hydration read. */
  currentDeadlineUtc: string;
}

/** The reader's zone, read once. The server has no reliable way to infer it. */
function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export function AmendForm({ commitmentId, currentDeadlineUtc }: AmendFormProps) {
  const router = useRouter();

  const [kind, setKind] = useState<AmendmentKind>("deadline_moved");
  const [deadlineDate, setDeadlineDate] = useState("");
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [submitting, setSubmitting] = useState(false);

  const timeZone = useMemo(browserTimeZone, []);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrors({});

    const parsed = AmendmentInputSchema.safeParse(
      kind === "deadline_moved"
        ? { kind, deadlineDate, timeZone, reason }
        : { kind, reason },
    );
    if (!parsed.success) {
      setErrors(toFieldErrors(parsed.error));
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch(`/api/v1/commitments/${commitmentId}/amendments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(parsed.data),
      });

      if (!response.ok) {
        const body: unknown = await response.json().catch(() => null);
        setErrors(readServerErrors(body));
        return;
      }

      router.push(`/c/${commitmentId}`);
      // The record page is ISR'd; without this the reader lands on a cached copy that does not
      // yet show the amendment they just made.
      router.refresh();
    } catch (error: unknown) {
      setErrors({ _: [error instanceof Error ? error.message : "Could not reach the server"] });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="composer" onSubmit={onSubmit} noValidate>
      <FieldError errors={errors["_"]} />

      <fieldset className="field">
        <legend className="field-label">What are you changing?</legend>
        <div className="radio-row">
          <label className="radio">
            <input
              type="radio"
              name="kind"
              value="deadline_moved"
              checked={kind === "deadline_moved"}
              onChange={() => {
                setKind("deadline_moved");
              }}
            />
            Move the deadline
          </label>
          <label className="radio">
            <input
              type="radio"
              name="kind"
              value="abandoned"
              checked={kind === "abandoned"}
              onChange={() => {
                setKind("abandoned");
              }}
            />
            Withdraw it
          </label>
        </div>
      </fieldset>

      {kind === "deadline_moved" ? (
        <label className="field">
          <span className="field-label">New deadline</span>
          <input
            name="deadlineDate"
            type="date"
            value={deadlineDate}
            onChange={(e) => {
              setDeadlineDate(e.target.value);
            }}
          />
          <span className="field-hint">
            End of that day in {timeZone}. Currently {currentDeadlineUtc}. The original deadline
            stays on the record, and the done-spec keeps reading <code>deadline</code> as the
            original one.
          </span>
          <FieldError errors={errors["deadlineDate"]} />
          <FieldError errors={errors["timeZone"]} />
        </label>
      ) : (
        <p className="note">
          Withdrawing resolves this commitment as <strong>withdrawn</strong>. It stays on your
          record, with this reason, permanently. It does not become a kept commitment and it
          does not disappear.
        </p>
      )}

      <label className="field">
        <span className="field-label">Why?</span>
        <textarea
          name="reason"
          rows={3}
          maxLength={REASON_MAX}
          value={reason}
          onChange={(e) => {
            setReason(e.target.value);
          }}
          placeholder="The API I depended on changed its auth model."
        />
        <span className="field-hint">
          Required, and published beside the amendment. A deadline that moves without a stated
          reason is the thing this record exists to prevent.
        </span>
        <FieldError errors={errors["reason"]} />
      </label>

      <button type="submit" disabled={submitting}>
        {submitting
          ? "Recording…"
          : kind === "deadline_moved"
            ? "Record the move"
            : "Withdraw it"}
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

/** The route handler's error body: `{ error, fields? }`. Anything else becomes one message. */
function readServerErrors(body: unknown): FieldErrors {
  if (typeof body !== "object" || body === null) {
    return { _: ["The server rejected this amendment"] };
  }
  const record = body as Record<string, unknown>;
  const fields = record["fields"];
  if (typeof fields === "object" && fields !== null) return fields as FieldErrors;
  return { _: [typeof record["error"] === "string" ? record["error"] : "Rejected"] };
}
