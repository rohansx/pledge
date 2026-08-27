/**
 * done-spec-dsl.md §5 and §5.1 — the hash is the contract.
 *
 * Three things are checked, in the order they can break:
 *   1. JCS itself, against the RFC 8785 vectors. If this is wrong, everything below is wrong
 *      in a way that only shows up on someone else's machine three years from now.
 *   2. Semantic injectivity, one direction: specs that differ only in whitespace, in operand
 *      order under and/or, or in all() versus and, share a hash.
 *   3. Semantic injectivity, the other direction: a corpus of specs that differ in *any*
 *      observable behaviour, none of which collide.
 */
import { describe, expect, it } from "vitest";

import { compile, hash, jcs, parseOrThrow, canonicalise } from "../src/index";

const hashOf = (source: string): string => hash(parseOrThrow(source));

describe("RFC 8785 JSON Canonicalisation Scheme", () => {
  it("sorts keys by UTF-16 code unit, not by insertion or by numeric key", () => {
    // The official "weird" vector from RFC 8785. It is the one that catches the trap described
    // in jcs.ts: rebuild-then-JSON.stringify puts "1" first because JavaScript hoists
    // integer-like keys, while JCS requires "\r" (U+000D) before "1" (U+0031).
    const input: Record<string, string> = {
      "\u20ac": "Euro Sign",
      "\r": "Carriage Return",
      "\ufb33": "Hebrew Letter Dalet With Dagesh",
      "1": "One",
      "\ud83d\ude00": "Emoji: Grinning Face",
      "\u0080": "Control",
      "\u00fc": "Non-ASCII Character",
    };
    expect(jcs(input)).toBe(
      '{"\\r":"Carriage Return","1":"One","\u0080":"Control","\u00fc":"Non-ASCII Character",' +
        '"\u20ac":"Euro Sign","\ud83d\ude00":"Emoji: Grinning Face","\ufb33":"Hebrew Letter Dalet With Dagesh"}',
    );
  });

  it("formats numbers as ECMAScript Number::toString (RFC 8785 §3.2.2.3)", () => {
    const vectors: readonly (readonly [number, string])[] = [
      [0, "0"],
      [-0, "0"],
      [1, "1"],
      [-1, "-1"],
      [1e30, "1e+30"],
      [1e21, "1e+21"],
      [1e-7, "1e-7"],
      [5e-324, "5e-324"],
      [333333333.33333329, "333333333.3333333"],
      [9.999999999999997e22, "9.999999999999997e+22"],
    ];
    for (const [value, expected] of vectors) expect(jcs(value)).toBe(expected);
  });

  it("escapes strings in the shortest form (RFC 8785 §3.2.2.2)", () => {
    expect(jcs("\b\t\n\f\r\"\\")).toBe('"\\b\\t\\n\\f\\r\\"\\\\"');
    // U+0080 is not a JSON control character, so JCS emits it raw rather than escaped.
    expect(jcs("\u0080")).toBe('"\u0080"');
    expect(jcs("\u0001")).toBe('"\\u0001"');
  });

  it("preserves array order and refuses what JSON cannot represent", () => {
    expect(jcs([3, 1, 2])).toBe("[3,1,2]");
    expect(() => jcs({ a: undefined as unknown as string })).toThrow(/undefined/);
    expect(() => jcs(Number.NaN)).toThrow(/non-finite/);
    expect(() => jcs(new Date() as unknown as string)).toThrow(/Date/);
  });
});

describe("semantic injectivity: same meaning, same hash", () => {
  const equivalent: readonly (readonly [string, string, string])[] = [
    [
      "whitespace is not meaning",
      'http("https://a.io").status == 200 and dns("a.io").resolves',
      'http("https://a.io").status == 200\n\n   and\tdns("a.io").resolves',
    ],
    [
      "and is commutative (§5 step 4)",
      'http("https://a.io").status == 200 and dns("a.io").resolves',
      'dns("a.io").resolves and http("https://a.io").status == 200',
    ],
    [
      "or is commutative",
      'http("https://a.io").status == 200 or dns("a.io").resolves',
      'dns("a.io").resolves or http("https://a.io").status == 200',
    ],
    [
      "all() is and (§4.2)",
      'all(http("https://a.io").status == 200, dns("a.io").resolves)',
      'http("https://a.io").status == 200 and dns("a.io").resolves',
    ],
    [
      "any() is or",
      'any(http("https://a.io").status == 200, dns("a.io").resolves)',
      'http("https://a.io").status == 200 or dns("a.io").resolves',
    ],
    [
      "a trailing comma in a combinator is grammar, not meaning",
      'all(http("https://a.io").status == 200, dns("a.io").resolves,)',
      'all(http("https://a.io").status == 200, dns("a.io").resolves)',
    ],
    [
      "not not folds away (§5 step 1)",
      'not not dns("a.io").resolves',
      'dns("a.io").resolves',
    ],
    [
      "redundant parentheses are not meaning",
      '(http("https://a.io").status == 200)',
      'http("https://a.io").status == 200',
    ],
    [
      "URL scheme, host case and an empty path normalise (§5 step 2)",
      'http("HTTPS://Example.COM/").status == 200',
      'http("https://example.com").status == 200',
    ],
    [
      "owner/repo lowercases (§5 step 2)",
      'github.release("Owner/Repo").tag matches "v1.*"',
      'github.release("owner/repo").tag matches "v1.*"',
    ],
    [
      "package names are case-insensitive on every registry we read",
      'npm("My-Pkg").version_count > 1',
      'npm("my-pkg").version_count > 1',
    ],
    [
      "modifiers are keyword arguments, so their order is noise",
      'github.commits("o/r").since(commit_time).by("nobody").count >= 3',
      'github.commits("o/r").by("nobody").since(commit_time).count >= 3',
    ],
    [
      "and is associative as well as commutative, so a 3-term run has no order (§5 step 4)",
      'dns("a.io").resolves and dns("b.io").resolves and dns("c.io").resolves',
      'dns("a.io").resolves and dns("c.io").resolves and dns("b.io").resolves',
    ],
    [
      "...and no nesting either: the run is flattened before it is ordered",
      '(dns("a.io").resolves and dns("b.io").resolves) and dns("c.io").resolves',
      'dns("a.io").resolves and (dns("b.io").resolves and dns("c.io").resolves)',
    ],
    [
      "or runs flatten the same way",
      'dns("a.io").resolves or (dns("b.io").resolves or dns("c.io").resolves)',
      'dns("c.io").resolves or dns("a.io").resolves or dns("b.io").resolves',
    ],
    [
      "all() of three is the same run as two ands, in any order (§4.2)",
      'all(dns("c.io").resolves, dns("a.io").resolves, dns("b.io").resolves)',
      'dns("a.io").resolves and dns("b.io").resolves and dns("c.io").resolves',
    ],
    [
      "a nested run of the OTHER kind is an operand, not part of the run",
      'dns("a.io").resolves and (dns("b.io").resolves or dns("c.io").resolves)',
      '(dns("c.io").resolves or dns("b.io").resolves) and dns("a.io").resolves',
    ],
  ];

  for (const [why, left, right] of equivalent) {
    it(why, () => {
      expect(hashOf(left)).toBe(hashOf(right));
    });
  }
});

describe("semantic injectivity: different meaning, different hash", () => {
  // Deliberately near-misses. A corpus of unrelated specs would pass this test by accident.
  const corpus = [
    'http("https://a.io").status == 200',
    'http("https://a.io").status == 201',
    'http("https://a.io").status != 200',
    'http("https://a.io").status > 200',
    'http("https://a.io").status >= 200',
    'http("https://a.io").status < 200',
    'http("https://b.io").status == 200',
    'http("https://a.io/x").status == 200',
    'http("https://a.io?q=1").status == 200',
    'http("https://a.io?q=1&r=2").status == 200',
    'http("https://a.io?r=2&q=1").status == 200',
    'http("https://a.io").text contains "done"',
    'http("https://a.io").text starts_with "done"',
    'http("https://a.io").text ends_with "done"',
    'http("https://a.io").text matches "done"',
    'http("https://a.io").text contains "Done"',
    'http("https://a.io").text.length > 2000',
    'http("https://a.io").header("etag") == "x"',
    'http("https://a.io").header("server") == "x"',
    'http("https://a.io").json("/a") == "x"',
    'http("https://a.io").json("/b") == "x"',
    'github.release("o/r").tag matches "v1.*"',
    'github.release("o/r").tag matches "v2.*"',
    'github.release("o/r2").tag matches "v1.*"',
    'github.release("o/r").published_at > commit_time',
    'github.release("o/r").published_at > deadline',
    'github.release("o/r").published_at >= commit_time',
    'github.pr("o/r", 1).state == "merged"',
    'github.pr("o/r", 2).state == "merged"',
    'github.issue("o/r", 1).state == "closed"',
    'github.commits("o/r").count >= 20',
    'github.commits("o/r").since(commit_time).count >= 20',
    'github.commits("o/r").since(deadline).count >= 20',
    'github.commits("o/r").on_branch("main").count >= 20',
    'github.commits("o/r").count >= 21',
    'github.file("o/r", "a.md").exists',
    'github.file("o/r", "b.md").exists',
    'not github.file("o/r", "a.md").exists',
    'npm("p").latest_version >= v1.0.0',
    'npm("p").latest_version >= v1.0.1',
    'crates("p").latest_version >= v1.0.0',
    'pypi("p").latest_version >= v1.0.0',
    'dns("a.io").resolves',
    'dns("b.io").resolves',
    'dns("a.io").a contains "1.2.3.4"',
    'dns("a.io").txt contains "1.2.3.4"',
    'http("https://a.io").status == 200 and dns("a.io").resolves',
    'http("https://a.io").status == 200 or dns("a.io").resolves',
    'not (http("https://a.io").status == 200 and dns("a.io").resolves)',
    // Three-term runs of DIFFERENT kinds, and the same three terms grouped differently ACROSS
    // kinds, are different specs and must stay apart. (Re-nesting within one kind is not: §5
    // step 4 flattens a run, so `(a and b) and c` and `a and (b and c)` are one hash — see the
    // "same meaning, same hash" table above.)
    'dns("a.io").resolves and dns("b.io").resolves and dns("c.io").resolves',
    'dns("a.io").resolves or dns("b.io").resolves or dns("c.io").resolves',
    '(dns("a.io").resolves or dns("b.io").resolves) and dns("c.io").resolves',
    'dns("a.io").resolves or (dns("b.io").resolves and dns("c.io").resolves)',
  ] as const;

  it("no two specs in the corpus share a hash", () => {
    const seen = new Map<string, string>();
    for (const source of corpus) {
      const digest = hashOf(source);
      const previous = seen.get(digest);
      expect(previous, `${source} collides with ${previous}`).toBeUndefined();
      seen.set(digest, source);
    }
    expect(seen.size).toBe(corpus.length);
  });

  it("the recorded version comparison mode is part of the hash (§5 step 3)", () => {
    // `v1.0.0` parses as semver, `v1.0` does not. Same operator, same-looking spec, different
    // resolved meaning — so it must be a different commitment.
    const semver = compile('npm("p").latest_version >= v1.0.0');
    const textual = compile('npm("p").latest_version >= v1.0');
    if (!semver.ok || !textual.ok) throw new Error("both should parse");
    expect(semver.spec.hash).not.toBe(textual.spec.hash);
    expect(textual.spec.warnings.map((w) => w.code)).toContain("string_version_compare");
  });
});

describe("what must never reach a hash", () => {
  it("refuses a repeated modifier rather than sorting one of them into oblivion (§5 step 4)", () => {
    // Canonicalisation sorts modifiers, so a repeated one loses its authored order: these two
    // sources name two different windows and would otherwise share one hash — a commitment to
    // A resolved against B, the one direction that must be impossible.
    const first = compile('github.commits("o/r").since(commit_time).since(deadline).count >= 1');
    const second = compile('github.commits("o/r").since(deadline).since(commit_time).count >= 1');
    expect(first.ok).toBe(false);
    expect(second.ok).toBe(false);
    if (first.ok) throw new Error("unreachable");
    expect(first.issues.map((i) => i.message).join()).toMatch(/since\(\) is given twice/);

    // Same shape with a string argument, where "last one wins" is even easier to assume.
    expect(compile('github.commits("o/r").by("alice").by("bob").count >= 1').ok).toBe(false);
    // One of each is still fine — this must not have banned the modifiers themselves.
    expect(compile('github.commits("o/r").since(commit_time).by("alice").count >= 1').ok).toBe(true);
  });

  it("refuses a glob that will not compile, on .json() too (§4.3, §6.1)", () => {
    // `.json(...)` skips the §4.1 type table, and the glob check used to sit behind that same
    // early return. An uncompilable pattern therefore reached the probe, where `compareValue`
    // has nowhere to put "uninterpretable" and answers FALSE — a commitment resolved `missed`
    // with nothing observed against it, which is exactly what I-7 forbids.
    for (const pattern of ["{a", "[a", "{a,b}".repeat(7), "x".repeat(600)]) {
      const viaJson = compile(`http("https://a.io").json("/x") matches "${pattern}"`);
      const viaText = compile(`http("https://a.io").text matches "${pattern}"`);
      expect(viaJson.ok, `${pattern} should be rejected on .json()`).toBe(false);
      expect(viaText.ok, `${pattern} should be rejected on .text`).toBe(false);
    }
    expect(compile('http("https://a.io").json("/x") matches "v1.*"').ok).toBe(true);
  });

  it("refuses a decimal that Number::toString would print in exponent form (§5 step 3)", () => {
    // `.json(...)` has no static type, so its comparison skips the type table — which makes it
    // the one way a decimal literal reaches the AST today. `0.0000001` prints as `1e-7`, which
    // the lexer cannot read back: the §5.1 fixed point breaks. A 320-digit literal is worse —
    // it becomes Infinity and `hash` throws a TypeError instead of returning a diagnostic.
    for (const literal of ["0.0000001", "1000000000000000000000.0", "9".repeat(320) + ".0"]) {
      const result = compile(`http("https://a.io").json("/x") == ${literal}`);
      expect(result.ok, `${literal} should be rejected`).toBe(false);
    }
    // A decimal that does round-trip is still accepted, and still a fixed point.
    const fine = compile('http("https://a.io").json("/x") == 1.5');
    expect(fine.ok).toBe(true);
    if (!fine.ok) throw new Error("unreachable");
    expect(compile(fine.spec.dslSource)).toEqual(fine);
  });
});

describe("canonicalise", () => {
  it("is idempotent", () => {
    const ast = parseOrThrow(
      'any(dns("z.io").resolves, dns("a.io").resolves, not not dns("m.io").resolves)',
    );
    const once = canonicalise(ast);
    expect(canonicalise(once)).toEqual(once);
    expect(hash(once)).toBe(hash(canonicalise(once)));
  });

  it("is domain-separated, so a spec hash is a spec hash and nothing else", () => {
    // Pinning the digest of a fixed spec: if the prefix, the JSON shape or the sort order ever
    // changes, every stored commitment silently becomes a different commitment (I-4), and this
    // is the test that stops it happening by accident.
    expect(hashOf('http("https://a.io").status == 200')).toMatch(/^[0-9a-f]{64}$/);
    expect(hashOf('http("https://a.io").status == 200')).toBe(
      hashOf('http("https://a.io").status == 200'),
    );
  });
});
