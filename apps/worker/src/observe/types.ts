/**
 * What a probe run hands to the pure evaluator.
 *
 * An Observation is a record of one *fetch* — one source, narrowed by whatever modifiers the
 * accessor carried — and it is either observed or not. There is no third shape, and no field
 * on the observed shape that can express "we could not reach it". That is invariant I-7
 * expressed as a type: the evaluator receives either values or an error, and a source that
 * did not answer cannot be silently read as a source that answered falsely.
 *
 * The two constructors in ./result.ts do the same job one level up, for the ProbeResult. This
 * file is the same discipline one level down, per source, because the surface that grew in v1
 * is the number of sources — and a new source type that could invent its own third outcome is
 * exactly how the invariant would rot.
 */
import type { Field, Modifier, Source } from "@pledge/spec";
import type { ObservationErrorCode } from "../probes/result";

/**
 * One distinct fetch. Two accessors reading `.status` and `.text` off the same URL share a
 * Target and therefore cost one request; two that differ in a modifier do not, because
 * `.since(commit_time)` narrows what is fetched rather than what is read from it.
 */
export interface Target {
  readonly source: Source;
  readonly modifiers: readonly Modifier[];
}

/**
 * A field to read, as the accessor wrote it: `["text","length"]` with no argument, or
 * `["header"]` with `"etag"`. The AST's own type — keying observations on a restated copy is
 * how the observation layer and the evaluator would come to disagree about what a field is.
 */
export type FieldRead = Field;

/**
 * Evidence about one observation, per done-spec-dsl.md §6.2. Facts about what came back,
 * never a conclusion about what it meant.
 */
export interface ObservationEvidence {
  readonly status?: number;
  /** Narrowed to the §6.2 header whitelist, lowercased keys. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly bodySha256?: string;
  readonly bodyBytes?: number;
  readonly resolvedIp?: string;
  readonly finalUrl?: string;
}

export type ObservedValue = string | number | boolean | null | readonly string[] | unknown;

export type Observation =
  | {
      readonly source: string;
      readonly observed: true;
      /** When the target answered. An observation time, not a state-change time. */
      readonly observedAt: string;
      /**
       * Field key (see ./field-key.ts) to value. A key present with value `null` means the
       * target answered and the field is genuinely absent — a header that was not sent, a
       * release that has no body. A key that is MISSING means the field could not be derived
       * from what came back, and the evaluator treats reading it as an error rather than as
       * a null comparison.
       */
      readonly values: Readonly<Record<string, ObservedValue>>;
      readonly evidence: ObservationEvidence;
    }
  | {
      readonly source: string;
      readonly observed: false;
      readonly observedAt: string;
      readonly error: { readonly code: ObservationErrorCode; readonly message: string };
      /** Whatever partial facts the failed attempt produced. A resolved IP is still a fact. */
      readonly evidence: ObservationEvidence;
    };

/** Resolved named instants (done-spec-dsl.md §3.5) plus the clock, for modifier arguments. */
export interface ObserveContext {
  readonly commitTime: Date;
  /** The ORIGINAL deadline. An amendment moves when we resolve, never what was promised. */
  readonly deadline: Date;
  readonly now: () => Date;
}
