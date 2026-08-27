/**
 * The source/field catalogue — done-spec-dsl.md §3, transcribed.
 *
 * This table is the whole of what spec_version 1 can observe. It is data, not code, so the
 * parser, the type checker, the evaluator, the printer and the probe classifier all agree
 * by construction. Adding a row here is a spec_version bump (§8), never a patch.
 */

export type ValueType =
  | "int"
  | "decimal"
  | "string"
  | "bool"
  | "version"
  | "timestamp"
  | "list"
  | "json";

/** How a source-constructor or call argument is validated and normalised. */
export type ParamKind = "url" | "repo" | "package" | "hostname" | "path" | "string" | "int" | "instant";

export type Param = { readonly name: string; readonly kind: ParamKind };

export type FieldDef = {
  readonly type: ValueType;
  /**
   * §7: does asserting on this field say something about the *substance* of the target,
   * as opposed to merely that it answered? `status` and `resolves` are liveness; everything
   * else is substance. Drives the trivial/weak boundary in classify.ts.
   */
  readonly content: boolean;
  /** `.header(name)` / `.json(pointer)` — the single string argument. */
  readonly arg?: ParamKind;
  readonly members?: Readonly<Record<string, FieldDef>>;
};

export type SourceDef = {
  readonly params: readonly Param[];
  readonly modifiers: Readonly<Record<string, readonly Param[]>>;
  readonly fields: Readonly<Record<string, FieldDef>>;
  /**
   * §7: a source whose state the committer cannot unilaterally author. A proxy, and an
   * imperfect one — see the honest-limitation note in §7 — but "I pushed a release to
   * GitHub" is checkable in a way "my landing page says done" is not.
   */
  readonly thirdParty: boolean;
};

const REPO: Param = { name: "repo", kind: "repo" };

/**
 * §6.2 header whitelist. Nothing else is readable, and therefore nothing else is stored:
 * response headers from arbitrary targets are a PII surface pledge has no reason to take.
 */
export const ALLOWED_HEADERS = [
  "content-type",
  "content-length",
  "last-modified",
  "etag",
  "location",
  "server",
] as const;

export const SOURCES = {
  "http": {
    params: [{ name: "url", kind: "url" }],
    modifiers: {},
    thirdParty: false,
    fields: {
      status: { type: "int", content: false },
      text: {
        type: "string",
        content: true,
        // §3.1: length in BYTES, not code points. The evaluator is handed the byte length
        // by the worker rather than computing `.length` on a JS string, which would be
        // UTF-16 code units and quietly wrong for any non-ASCII page.
        members: { length: { type: "int", content: true } },
      },
      final_url: { type: "string", content: false },
      header: { type: "string", content: true, arg: "string" },
      json: { type: "json", content: true, arg: "string" },
    },
  },
  "github.release": {
    params: [REPO],
    modifiers: {},
    thirdParty: true,
    fields: {
      tag: { type: "string", content: true },
      name: { type: "string", content: true },
      body: { type: "string", content: true },
      published_at: { type: "timestamp", content: true },
      is_prerelease: { type: "bool", content: true },
      asset_count: { type: "int", content: true },
    },
  },
  "github.pr": {
    params: [REPO, { name: "number", kind: "int" }],
    modifiers: {},
    thirdParty: true,
    fields: {
      state: { type: "string", content: true },
      merged_at: { type: "timestamp", content: true },
      additions: { type: "int", content: true },
      deletions: { type: "int", content: true },
      review_count: { type: "int", content: true },
    },
  },
  "github.issue": {
    params: [REPO, { name: "number", kind: "int" }],
    modifiers: {},
    thirdParty: true,
    fields: {
      state: { type: "string", content: true },
      closed_at: { type: "timestamp", content: true },
      label_names: { type: "list", content: true },
    },
  },
  "github.commits": {
    params: [REPO],
    modifiers: {
      since: [{ name: "from", kind: "instant" }],
      on_branch: [{ name: "branch", kind: "string" }],
      by: [{ name: "login", kind: "string" }],
    },
    thirdParty: true,
    fields: {
      count: { type: "int", content: true },
      latest_sha: { type: "string", content: true },
      latest_at: { type: "timestamp", content: true },
    },
  },
  "github.file": {
    params: [REPO, { name: "path", kind: "path" }],
    modifiers: {},
    thirdParty: true,
    fields: {
      exists: { type: "bool", content: false },
      sha: { type: "string", content: true },
      size: { type: "int", content: true },
      text: { type: "string", content: true },
    },
  },
  "github.workflow": {
    params: [REPO, { name: "name", kind: "string" }],
    modifiers: { since: [{ name: "from", kind: "instant" }] },
    thirdParty: true,
    fields: {
      latest_conclusion: { type: "string", content: true },
      latest_at: { type: "timestamp", content: true },
      success_count: { type: "int", content: true },
    },
  },
  "npm": {
    params: [{ name: "package", kind: "package" }],
    modifiers: {},
    thirdParty: true,
    fields: {
      latest_version: { type: "version", content: true },
      published_at: { type: "timestamp", content: true },
      version_count: { type: "int", content: true },
      unpacked_size: { type: "int", content: true },
    },
  },
  "crates": {
    params: [{ name: "package", kind: "package" }],
    modifiers: {},
    thirdParty: true,
    fields: {
      latest_version: { type: "version", content: true },
      published_at: { type: "timestamp", content: true },
      downloads: { type: "int", content: true },
    },
  },
  "pypi": {
    params: [{ name: "package", kind: "package" }],
    modifiers: {},
    thirdParty: true,
    fields: {
      latest_version: { type: "version", content: true },
      published_at: { type: "timestamp", content: true },
      release_count: { type: "int", content: true },
    },
  },
  "dns": {
    params: [{ name: "name", kind: "hostname" }],
    modifiers: {},
    // §3.4: DNS is observation only. The SSRF layer blocks connecting, not resolving, so a
    // private-range answer is reportable without pledge ever contacting it.
    thirdParty: false,
    fields: {
      a: { type: "list", content: true },
      cname: { type: "string", content: true },
      txt: { type: "list", content: true },
      resolves: { type: "bool", content: false },
    },
  },
} as const satisfies Readonly<Record<string, SourceDef>>;

export type CatalogueKind = keyof typeof SOURCES;

export function sourceDef(kind: string): SourceDef | undefined {
  return (SOURCES as Readonly<Record<string, SourceDef>>)[kind];
}

/** Walks a dotted member chain to its leaf, or undefined if the chain does not exist. */
export function resolveFieldPath(kind: string, path: readonly string[]): FieldDef | undefined {
  const def = sourceDef(kind);
  if (!def) return undefined;
  let current: FieldDef | undefined = def.fields[path[0] ?? ""];
  for (const segment of path.slice(1)) {
    current = current?.members?.[segment];
  }
  return current;
}
