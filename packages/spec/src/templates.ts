/**
 * The five v1 templates, transcribed from done-spec-dsl.md §9.
 *
 * The expansions in the table there are NORMATIVE. This module's only job is to turn a
 * template plus the blanks a user filled into that exact source text — it does not parse,
 * validate or hash anything; `parse` and `hash` in this package own all three, and a second
 * opinion here about what a repo name or a version literal may contain is precisely the
 * divergence that makes a rendered spec stop meaning what the hashed spec means.
 *
 * Every template carries a `> commit_time` freshness clause where its source supports one
 * (§9): a release that already existed when you committed must never satisfy a promise to
 * make it, and that is the most likely *accidental* false pass rather than an adversarial one.
 *
 * It lives here rather than in the composer because `@pledge/spec` is the package a third
 * party reads to learn what a pledge means, and "what the five templates actually check" is
 * part of that. apps/web/lib/templates.ts is the same table, written before this package
 * existed; it should become a re-export of this module.
 *
 * Browser-safe: no Node imports, no @pledge/db (CLAUDE.md I-6).
 */

/** Drives the input type the composer renders. Not a validation rule — see the note above. */
export type BlankKind = "repo" | "glob" | "url" | "text" | "package" | "version" | "int";

export interface Blank {
  /** Key into the values record, and the form input's name. */
  readonly name: string;
  readonly label: string;
  readonly kind: BlankKind;
  readonly placeholder: string;
  readonly hint?: string;
}

export const templateIds = [
  "release_version",
  "url_live_with_content",
  "publish_package",
  "merge_pr",
  "sustained_work",
] as const;
export type TemplateId = (typeof templateIds)[number];

export type BlankValues = Readonly<Record<string, string>>;

export interface Template {
  readonly id: TemplateId;
  /** What the user picks from. §9: "Users see the left column." */
  readonly label: string;
  /** One line on what the probe will actually check. Past-tense-safe, no encouragement. */
  readonly summary: string;
  readonly blanks: readonly Blank[];
  /** The §9 expansion, with blanks substituted. Returns DSL source, nothing else. */
  readonly expand: (values: BlankValues) => string;
}

/**
 * A DSL string literal. `JSON.stringify` emits exactly the grammar's
 * `'"' { char } '"'` with JSON escapes (§2), which is the same production the lexer accepts.
 *
 * Control characters come back as `\n`-style escapes here and are then rejected by
 * canonicalisation (normalise.ts: "a spec whose rendered source does not match its meaning is
 * exactly what this product exists not to produce"). That rejection is the correct place for
 * it — this function's job is to render, and silently dropping the character would hide the
 * problem from the person about to commit to it.
 */
export function quote(value: string): string {
  return JSON.stringify(value);
}

/** A blank the user has not filled yet, rendered so the preview reads as a gap, not a value. */
const EMPTY = "…";

function take(values: BlankValues, name: string): string {
  const value = values[name];
  return value === undefined || value === "" ? EMPTY : value;
}

/** A blank that becomes a quoted string literal. Left unquoted while still empty. */
function takeString(values: BlankValues, name: string): string {
  const value = values[name];
  return value === undefined || value === "" ? EMPTY : quote(value);
}

export const TEMPLATES: readonly Template[] = [
  {
    id: "release_version",
    label: "Release a version",
    summary: "A release exists whose tag matches, and it was published after you committed.",
    blanks: [
      { name: "repo", label: "Repository", kind: "repo", placeholder: "owner/name" },
      {
        name: "tag",
        label: "Tag pattern",
        kind: "glob",
        placeholder: "v0.1.*",
        hint: "A glob, not a regular expression: * ? [a-z] {a,b}.",
      },
    ],
    expand: (v) => {
      const repo = takeString(v, "repo");
      return (
        `github.release(${repo}).tag matches ${takeString(v, "tag")}` +
        ` and github.release(${repo}).published_at > commit_time`
      );
    },
  },
  {
    id: "url_live_with_content",
    label: "URL is live with content",
    summary: "The page answers 200, contains the phrase, and is not a stub.",
    blanks: [
      { name: "url", label: "URL", kind: "url", placeholder: "https://example.com/changelog" },
      {
        name: "content",
        label: "Text it must contain",
        kind: "text",
        placeholder: "v0.1.0",
        hint: "Matched against the page body as received.",
      },
    ],
    expand: (v) => {
      const url = takeString(v, "url");
      return (
        `http(${url}).status == 200` +
        ` and http(${url}).text contains ${takeString(v, "content")}` +
        ` and http(${url}).text.length > 2000`
      );
    },
  },
  {
    id: "publish_package",
    label: "Publish a package",
    summary: "npm carries at least this version, published after you committed.",
    blanks: [
      { name: "package", label: "Package", kind: "package", placeholder: "my-package" },
      {
        name: "version",
        label: "Minimum version",
        kind: "version",
        placeholder: "v0.2.0",
        // §4.1: the >= here is the one comparison in the five templates whose MEANING depends
        // on whether both sides parse as semver. The composer must show the resolved mode.
        hint: "Compared as semver when both sides parse as semver, as text otherwise.",
      },
    ],
    expand: (v) => {
      const pkg = takeString(v, "package");
      return (
        `npm(${pkg}).latest_version >= ${take(v, "version")}` +
        ` and npm(${pkg}).published_at > commit_time`
      );
    },
  },
  {
    id: "merge_pr",
    label: "Merge a PR",
    summary: "The pull request is in the merged state.",
    blanks: [
      { name: "repo", label: "Repository", kind: "repo", placeholder: "owner/name" },
      { name: "number", label: "PR number", kind: "int", placeholder: "42" },
    ],
    // No freshness clause: `.state == "merged"` is already a statement about the PR's current
    // state, and §9's table has none here. Do not add one — the table is normative.
    expand: (v) =>
      `github.pr(${takeString(v, "repo")}, ${take(v, "number")}).state == "merged"`,
  },
  {
    id: "sustained_work",
    label: "Sustained work",
    summary: "At least this many commits landed after you committed.",
    blanks: [
      { name: "repo", label: "Repository", kind: "repo", placeholder: "owner/name" },
      { name: "count", label: "Commits", kind: "int", placeholder: "20" },
    ],
    expand: (v) =>
      `github.commits(${takeString(v, "repo")}).since(commit_time).count >= ${take(v, "count")}`,
  },
];

const BY_ID = new Map<TemplateId, Template>(TEMPLATES.map((t) => [t.id, t]));

export function getTemplate(id: TemplateId): Template {
  const template = BY_ID.get(id);
  // Unreachable through the typed API; reachable through a stale URL parameter cast to the
  // union. Throwing beats returning a default that would silently expand to another spec.
  if (template === undefined) throw new Error(`unknown template: ${id}`);
  return template;
}

/** True once every blank has a value. The composer gates the preview on it. */
export function isComplete(template: Template, values: BlankValues): boolean {
  return template.blanks.every((blank) => (values[blank.name] ?? "") !== "");
}
