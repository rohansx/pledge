/**
 * @pledge/spec — the done-spec DSL.
 *
 * This is the whole public surface. The worker, the composer and `npx pledge-verify` all build
 * against it, and it is MIT-licensed and open precisely so a third party can check that a
 * receipt means what pledge says it means (architecture.md §9).
 *
 * INVARIANT I-6: nothing reachable from here imports @pledge/db or a Node-only API. The
 * package's tsconfig sets `types: []`, so a stray `node:crypto` fails to typecheck rather than
 * failing in a browser bundle at 3am.
 *
 * The pipeline, end to end:
 *
 *     parse(source)  →  ast          §2, §3, §5 steps 2–3
 *     canonicalise   →  ast'         §5 steps 1, 4
 *     canonicalJson  →  bytes        §5 steps 5–6
 *     hash           →  done_spec.hash   §5 step 7
 *     print          →  source'      the fixed point of §5.1
 *     classify       →  probe class  §7, frozen at commit time
 *     evaluate       →  pass/fail/error  §6, given observations, never fetching
 */

// ---- the AST: the thing that is hashed, stored and evaluated -----------------------------
export {
  SPEC_VERSION,
  SpecNodeSchema,
  AccessorSchema,
  FieldSchema,
  InstantSchema,
  LiteralSchema,
  ModifierSchema,
  OperandSchema,
  SourceSchema,
  compareOps,
  instantNames,
  sourceKinds,
  type Accessor,
  type AndNode,
  type CompareNode,
  type CompareOp,
  type Field,
  type Instant,
  type InstantName,
  type Literal,
  type Modifier,
  type NotNode,
  type Operand,
  type OrNode,
  type Source,
  type SourceKind,
  type SpecNode,
  type TruthyNode,
} from "./ast";

// ---- source → AST -------------------------------------------------------------------------
export { parse, parseOrThrow, type ParseResult } from "./parse";

// ---- AST → hash, and back to source -------------------------------------------------------
export { canonicalise, canonicalJson, hash, toJson } from "./canonicalise";
export { print, printAccessor, printOperand } from "./print";
export { jcs, type JsonValue } from "./jcs";

// ---- what the observations mean -----------------------------------------------------------
export {
  evaluate,
  type Evaluation,
  type EvaluationInput,
  type Observation,
  type Subresult,
} from "./evaluate";
export { classify, probeClasses, type ProbeClass } from "./classify";

// ---- the join between an accessor and what was observed ------------------------------------
export { fieldKey, resolveInstant, sourceKey, targetKey, type Instants } from "./keys";

// ---- the catalogue: what spec_version 1 can observe (§3) ------------------------------------
export {
  ALLOWED_HEADERS,
  SOURCES,
  resolveFieldPath,
  sourceDef,
  type FieldDef,
  type Param,
  type ParamKind,
  type SourceDef,
  type ValueType,
} from "./catalogue";

// ---- templates (§9) -------------------------------------------------------------------------
export {
  TEMPLATES,
  getTemplate,
  isComplete,
  quote,
  templateIds,
  type Blank,
  type BlankKind,
  type BlankValues,
  type Template,
  type TemplateId,
} from "./templates";

// ---- diagnostics ---------------------------------------------------------------------------
export {
  SpecError,
  specIssueCodes,
  specWarningCodes,
  type SpecIssue,
  type SpecIssueCode,
  type SpecWarning,
  type SpecWarningCode,
} from "./errors";

// ---- version comparison and globs, exported because the composer explains them to the user ---
export { compareSemver, compareVersions, parseSemver, type Semver } from "./version";
export { GlobError, compileGlob, globMatches, type CompiledGlob } from "./glob";

import { canonicalise, hash } from "./canonicalise";
import { classify, type ProbeClass } from "./classify";
import type { SpecNode } from "./ast";
import type { SpecIssue, SpecWarning } from "./errors";
import { parse } from "./parse";
import { print } from "./print";

export type CompiledSpec = {
  readonly ast: SpecNode;
  readonly hash: string;
  /** Stored for display and NOT hashed (§5 step 5). The canonical rendering, not what was typed. */
  readonly dslSource: string;
  readonly probeClass: ProbeClass;
  readonly warnings: readonly SpecWarning[];
};

/**
 * Everything a caller needs to write a `done_spec` row and a `commitment`, in one call.
 *
 * It exists so no caller has to remember the order of the pipeline. Getting that order wrong —
 * hashing before canonicalising, say — produces a plausible hash for the wrong thing, and
 * nothing downstream would notice (CLAUDE.md I-4).
 */
export function compile(
  source: string,
): { readonly ok: true; readonly spec: CompiledSpec } | { readonly ok: false; readonly issues: readonly SpecIssue[] } {
  const parsed = parse(source);
  if (!parsed.ok) return { ok: false, issues: parsed.issues };
  const ast = canonicalise(parsed.ast);
  return {
    ok: true,
    spec: {
      ast,
      hash: hash(ast),
      dslSource: print(ast),
      probeClass: classify(ast),
      warnings: parsed.warnings,
    },
  };
}
