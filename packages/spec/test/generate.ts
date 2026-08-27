/**
 * A deterministic done-spec generator, for the property tests.
 *
 * Hand-written rather than fast-check, on purpose: the useful generator here is *grammar and
 * catalogue driven* — it has to pick a source, then a field that source has, then an operator
 * that field's type admits, then a literal of the type that operator wants. Expressing that in
 * a combinator library is more code than expressing it directly, and a shrinker is not much
 * use for a fixed-point property where every failure is already a one-line spec.
 *
 * The seed is fixed so a failure is reproducible from the test name alone.
 */
import { SOURCES, type ValueType } from "../src/catalogue";

/** mulberry32 — small, fast, and identical on every machine, which is the only requirement. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(random: () => number, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)] as T;
}

const URLS = [
  "https://example.com",
  "https://example.com/changelog",
  "https://a.example.org/x/y?q=1",
  "https://sub.domain.example.net/path",
] as const;
const REPOS = ["owner/name", "acme/widget", "o/r", "a-b/c.d"] as const;
const PACKAGES = ["pkg", "@scope/pkg", "my-package", "some_lib"] as const;
const HOSTS = ["example.com", "a.example.org", "pledge.sh"] as const;
const PATHS = ["README.md", "docs/spec.md", "src/index.ts"] as const;
const WORKFLOWS = ["ci", "release.yml", "Deploy"] as const;
const HEADERS = ["etag", "content-type", "last-modified", "server"] as const;
const POINTERS = ["", "/deployed", "/a/b", "/items/0"] as const;
const TEXTS = ["done", "Verify a receipt", "v0.1.0", "shipped"] as const;
const GLOBS = ["v0.1.*", "v[0-9].*", "{alpha,beta}-*", "?.?.?", "*"] as const;
const VERSIONS = ["v0.1.0", "1.2.3", "v2.0.0-rc.1", "v10.0.0"] as const;

/** DSL string literal. `JSON.stringify` is exactly the grammar's string production (§2). */
const q = (value: string): string => JSON.stringify(value);

function source(random: () => number): { readonly kind: string; readonly text: string } {
  const kind = pick(random, Object.keys(SOURCES));
  switch (kind) {
    case "http":
      return { kind, text: `http(${q(pick(random, URLS))})` };
    case "github.pr":
    case "github.issue":
      return { kind, text: `${kind}(${q(pick(random, REPOS))}, ${1 + Math.floor(random() * 999)})` };
    case "github.file":
      return { kind, text: `github.file(${q(pick(random, REPOS))}, ${q(pick(random, PATHS))})` };
    case "github.workflow":
      return { kind, text: `github.workflow(${q(pick(random, REPOS))}, ${q(pick(random, WORKFLOWS))})` };
    case "github.release":
    case "github.commits":
      return { kind, text: `${kind}(${q(pick(random, REPOS))})` };
    case "dns":
      return { kind, text: `dns(${q(pick(random, HOSTS))})` };
    default:
      return { kind, text: `${kind}(${q(pick(random, PACKAGES))})` };
  }
}

function modifiers(random: () => number, kind: string): string {
  const available = Object.keys(SOURCES[kind as keyof typeof SOURCES].modifiers);
  return available
    .filter(() => random() < 0.4)
    .map((name) => {
      if (name === "since") return `.since(${random() < 0.5 ? "commit_time" : "deadline"})`;
      if (name === "on_branch") return `.on_branch(${q("main")})`;
      return `.by(${q("someone")})`;
    })
    .join("");
}

/** A field of `kind`, as source text, plus the type the operator has to accept. */
function field(
  random: () => number,
  kind: string,
): { readonly text: string; readonly type: ValueType } {
  const fields = SOURCES[kind as keyof typeof SOURCES].fields as Readonly<
    Record<string, { type: ValueType; members?: Readonly<Record<string, { type: ValueType }>> }>
  >;
  const name = pick(random, Object.keys(fields));
  const def = fields[name] as { type: ValueType; members?: Readonly<Record<string, { type: ValueType }>> };

  if (name === "header") return { text: `.header(${q(pick(random, HEADERS))})`, type: "string" };
  if (name === "json") return { text: `.json(${q(pick(random, POINTERS))})`, type: "json" };

  const members = def.members;
  if (members !== undefined && random() < 0.4) {
    const member = pick(random, Object.keys(members));
    const memberDef = members[member];
    if (memberDef !== undefined) return { text: `.${name}.${member}`, type: memberDef.type };
  }
  return { text: `.${name}`, type: def.type };
}

function comparison(random: () => number, type: ValueType): string | undefined {
  switch (type) {
    case "int":
      return `${pick(random, ["==", "!=", ">", ">=", "<", "<="] as const)} ${Math.floor(random() * 5000)}`;
    case "decimal":
      return `${pick(random, [">", "<"] as const)} ${Math.floor(random() * 100)}.5`;
    case "string":
      return `${pick(random, ["==", "!=", "contains", "starts_with", "ends_with", "matches"] as const)} ${
        random() < 0.3 ? q(pick(random, GLOBS)) : q(pick(random, TEXTS))
      }`;
    case "version":
      return `${pick(random, ["==", "!=", ">", ">=", "<", "<="] as const)} ${pick(random, VERSIONS)}`;
    case "timestamp":
      return `${pick(random, ["==", ">", ">=", "<", "<="] as const)} ${random() < 0.5 ? "commit_time" : "deadline"}`;
    case "list":
      return `contains ${q(pick(random, TEXTS))}`;
    case "bool":
      // A bare accessor is legal here (§2), and exercising it is the point of returning
      // undefined rather than always emitting `== true`.
      return random() < 0.5 ? undefined : `${pick(random, ["==", "!="] as const)} ${random() < 0.5}`;
    case "json":
      return random() < 0.5 ? undefined : `== ${q(pick(random, TEXTS))}`;
  }
}

/** `matches` needs a glob, and only a glob-shaped needle exercises the compiler. */
function leaf(random: () => number): string {
  const src = source(random);
  const f = field(random, src.kind);
  const op = comparison(random, f.type);
  const accessor = `${src.text}${modifiers(random, src.kind)}${f.text}`;
  return op === undefined ? accessor : `${accessor} ${op}`;
}

/** Whitespace is not meaning (§5.1), so the generator sprays it around. */
function gap(random: () => number): string {
  return pick(random, [" ", "  ", " \n", "\n  ", "\t", " \n\n "] as const);
}

export function generateSpec(random: () => number, depth = 0): string {
  if (depth >= 3 || random() < 0.45) return leaf(random);

  const roll = random();
  if (roll < 0.15) return `not${gap(random)}${wrapped(random, depth)}`;
  if (roll < 0.3) {
    const combinator = random() < 0.5 ? "all" : "any";
    const arity = 2 + Math.floor(random() * 2);
    const args = Array.from({ length: arity }, () => generateSpec(random, depth + 1));
    return `${combinator}(${args.join(`,${gap(random)}`)}${random() < 0.2 ? "," : ""})`;
  }
  const op = roll < 0.65 ? "and" : "or";
  return `${wrapped(random, depth)}${gap(random)}${op}${gap(random)}${wrapped(random, depth)}`;
}

function wrapped(random: () => number, depth: number): string {
  const inner = generateSpec(random, depth + 1);
  return random() < 0.3 ? `(${inner})` : inner;
}
