"use client";

/**
 * Picking a done-condition: the five §9 templates, or the DSL itself.
 *
 * The escape hatch is not a separate composer. "Write it yourself" opens on the *expansion of
 * whatever you had*, so the DSL is discovered by editing something that already works rather
 * than by reading a grammar — and so the five templates double as the documentation for it.
 *
 * The template table is `@pledge/spec`'s. This file renders it and holds no copy of it: §9 is
 * normative, and a second transcription would be a second thing to keep true.
 */
import { TEMPLATES, getTemplate, type BlankValues, type TemplateId } from "@pledge/spec";
import { INPUT_PROPS } from "./spec-source";

export interface SpecEditorProps {
  readonly templateId: TemplateId;
  readonly values: BlankValues;
  /** `null` is template mode. A string is raw-DSL mode, and is that mode's source of truth. */
  readonly raw: string | null;
  /** The source the form would submit right now — used to seed the textarea on the way in. */
  readonly source: string;
  readonly onTemplate: (id: TemplateId) => void;
  readonly onValue: (name: string, value: string) => void;
  readonly onRaw: (source: string | null) => void;
}

export function SpecEditor(props: SpecEditorProps) {
  const template = getTemplate(props.templateId);

  return (
    <fieldset className="field">
      <legend className="field-label">What has to be observed for this to count?</legend>

      {props.raw === null ? (
        <>
          <div className="radio-row">
            {TEMPLATES.map((t) => (
              <label key={t.id} className="radio">
                <input
                  type="radio"
                  name="template"
                  value={t.id}
                  checked={t.id === props.templateId}
                  onChange={() => {
                    props.onTemplate(t.id);
                  }}
                />
                <span>
                  {t.label}
                  <span className="field-hint"> — {t.summary}</span>
                </span>
              </label>
            ))}
          </div>

          {template.blanks.map((blank) => {
            const input = INPUT_PROPS[blank.kind];
            return (
              <label key={blank.name} className="field">
                <span className="field-label">{blank.label}</span>
                <input
                  name={`blank.${blank.name}`}
                  type={input.type}
                  {...(input.inputMode === undefined ? {} : { inputMode: input.inputMode })}
                  spellCheck={input.spellCheck}
                  value={props.values[blank.name] ?? ""}
                  placeholder={blank.placeholder}
                  onChange={(e) => {
                    props.onValue(blank.name, e.target.value);
                  }}
                />
                {blank.hint === undefined ? null : (
                  <span className="field-hint">{blank.hint}</span>
                )}
              </label>
            );
          })}
        </>
      ) : (
        <label className="field">
          <span className="field-label">Done-spec</span>
          <textarea
            name="specSource"
            className="dsl"
            rows={4}
            spellCheck={false}
            value={props.raw}
            onChange={(e) => {
              props.onRaw(e.target.value);
            }}
          />
          <span className="field-hint">
            Sources, fields and comparisons are checked as you type. Everything the probe is
            able to observe is listed in the done-spec reference.
          </span>
        </label>
      )}

      <button
        type="button"
        className="link-button"
        onClick={() => {
          // Into raw mode carrying the current expansion; out of it discarding the edit, back
          // to the blanks that were already filled in. Both directions are one click and
          // neither can lose the claim or the deadline.
          props.onRaw(props.raw === null ? props.source : null);
        }}
      >
        {props.raw === null ? "Write it yourself instead" : "Back to the templates"}
      </button>
    </fieldset>
  );
}
