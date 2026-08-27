/**
 * The AST — the thing that is hashed, stored in `done_spec.ast`, and evaluated.
 *
 * Zod does double duty here (technical-spec.md §4): it validates the shape and it produces
 * the TypeScript types the evaluator is written against, so parser and evaluator cannot
 * drift. The recursive `SpecNode` union is the one place the type is written by hand —
 * Zod cannot infer through `z.lazy` — and the schema is then pinned to it with
 * `z.ZodType<SpecNode>`, so a mismatch is a compile error rather than a runtime surprise.
 *
 * INVARIANT I-4: an AST is a value, never a mutable record. Nothing here is edited in place.
 * INVARIANT I-6: no Node-only imports, no @pledge/db.
 */
import { z } from "zod";

/** Pins evaluation semantics forever (done-spec-dsl.md §8). */
export const SPEC_VERSION = 1 as const;

// ---------------------------------------------------------------------------------------
// Sources (§3)
// ---------------------------------------------------------------------------------------

/**
 * Kinds are spelled as they are in the DSL so that an evidence key (`github.commits:o/r`)
 * reads the same as the spec a human is looking at.
 */
export const sourceKinds = [
  "http",
  "github.release",
  "github.pr",
  "github.issue",
  "github.commits",
  "github.file",
  "github.workflow",
  "npm",
  "crates",
  "pypi",
  "dns",
] as const;
export type SourceKind = (typeof sourceKinds)[number];

/** `owner/repo`, already lowercased by canonicalisation step 2. */
const RepoSchema = z.string().regex(/^[a-z0-9._-]{1,100}\/[a-z0-9._-]{1,100}$/);

export const SourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("http"), url: z.string().min(1) }),
  z.object({ kind: z.literal("github.release"), repo: RepoSchema }),
  z.object({ kind: z.literal("github.pr"), repo: RepoSchema, number: z.int().positive() }),
  z.object({ kind: z.literal("github.issue"), repo: RepoSchema, number: z.int().positive() }),
  z.object({ kind: z.literal("github.commits"), repo: RepoSchema }),
  z.object({ kind: z.literal("github.file"), repo: RepoSchema, path: z.string().min(1) }),
  z.object({ kind: z.literal("github.workflow"), repo: RepoSchema, workflow: z.string().min(1) }),
  z.object({ kind: z.literal("npm"), package: z.string().min(1) }),
  z.object({ kind: z.literal("crates"), package: z.string().min(1) }),
  z.object({ kind: z.literal("pypi"), package: z.string().min(1) }),
  z.object({ kind: z.literal("dns"), name: z.string().min(1) }),
]);
export type Source = z.infer<typeof SourceSchema>;

// ---------------------------------------------------------------------------------------
// Literals and named instants (§3.5, §5 step 3)
// ---------------------------------------------------------------------------------------

/**
 * `deadline` is the ORIGINAL deadline, never the amended one (§3.5). An amendment moves
 * when we resolve; it never changes what was promised.
 */
export const instantNames = ["commit_time", "deadline"] as const;
export type InstantName = (typeof instantNames)[number];

export const InstantSchema = z.object({
  type: z.literal("instant"),
  name: z.enum(instantNames),
});
export type Instant = z.infer<typeof InstantSchema>;

/**
 * `compare` is recorded explicitly rather than inferred at eval time (§5 step 3): the
 * comparison mode is part of what was promised, so it belongs in the hash.
 */
export const LiteralSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("string"), value: z.string() }),
  z.object({ type: z.literal("int"), value: z.int() }),
  z.object({ type: z.literal("decimal"), value: z.number().finite() }),
  z.object({ type: z.literal("bool"), value: z.boolean() }),
  z.object({
    type: z.literal("version"),
    value: z.string().min(1),
    compare: z.enum(["semver", "string"]),
  }),
]);
export type Literal = z.infer<typeof LiteralSchema>;

export const OperandSchema = z.union([LiteralSchema, InstantSchema]);
export type Operand = z.infer<typeof OperandSchema>;

// ---------------------------------------------------------------------------------------
// Accessors (§2 `accessor`, §3 fields)
// ---------------------------------------------------------------------------------------

/**
 * A call that narrows the fetch rather than reading from it: `.since(t)`, `.on_branch(s)`,
 * `.by(s)`. Two accessors differing in a modifier are two different fetches.
 */
export const ModifierSchema = z.object({
  name: z.enum(["since", "on_branch", "by"]),
  args: z.array(OperandSchema),
});
export type Modifier = z.infer<typeof ModifierSchema>;

/**
 * The read itself. `path` is the dotted member chain (`["text", "length"]`); `arg` is the
 * single string argument of the two parameterised reads, `.header(name)` and `.json(ptr)`.
 */
export const FieldSchema = z.object({
  path: z.array(z.string().min(1)).min(1),
  arg: z.string().optional(),
});
export type Field = z.infer<typeof FieldSchema>;

export const AccessorSchema = z.object({
  source: SourceSchema,
  /** Canonically sorted; modifiers are keyword arguments, so their authored order is noise. */
  modifiers: z.array(ModifierSchema),
  field: FieldSchema,
});
export type Accessor = z.infer<typeof AccessorSchema>;

// ---------------------------------------------------------------------------------------
// Nodes (§2, §4)
// ---------------------------------------------------------------------------------------

export const compareOps = [
  "==",
  "!=",
  ">",
  ">=",
  "<",
  "<=",
  "contains",
  "matches",
  "starts_with",
  "ends_with",
] as const;
export type CompareOp = (typeof compareOps)[number];

export type AndNode = { readonly kind: "and"; readonly left: SpecNode; readonly right: SpecNode };
export type OrNode = { readonly kind: "or"; readonly left: SpecNode; readonly right: SpecNode };
export type NotNode = { readonly kind: "not"; readonly operand: SpecNode };
export type CompareNode = {
  readonly kind: "compare";
  readonly op: CompareOp;
  readonly left: Accessor;
  readonly right: Operand;
};
/** A bare accessor. The grammar allows it only where the field is boolean-typed. */
export type TruthyNode = { readonly kind: "truthy"; readonly accessor: Accessor };

export type SpecNode = AndNode | OrNode | NotNode | CompareNode | TruthyNode;

export const SpecNodeSchema: z.ZodType<SpecNode> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("and"), left: SpecNodeSchema, right: SpecNodeSchema }),
    z.object({ kind: z.literal("or"), left: SpecNodeSchema, right: SpecNodeSchema }),
    z.object({ kind: z.literal("not"), operand: SpecNodeSchema }),
    z.object({
      kind: z.literal("compare"),
      op: z.enum(compareOps),
      left: AccessorSchema,
      right: OperandSchema,
    }),
    z.object({ kind: z.literal("truthy"), accessor: AccessorSchema }),
  ]),
);
