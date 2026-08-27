/**
 * v1 exit criterion: `parse → canonicalise → serialise → parse` is a FIXED POINT over 500
 * generated specs (roadmap.md, done-spec-dsl.md §5.1).
 *
 * "Fixed point" is the strong reading, and the one asserted here: printing the canonical AST
 * and re-parsing it yields the same AST, byte-identical source, and the same hash. Anything
 * weaker would let the printer and the parser disagree about a corner — a dropped parenthesis,
 * a decimal that comes back as an integer — and the first anyone would notice is a commitment
 * whose rendered spec is not the spec that was hashed.
 */
import { describe, expect, it } from "vitest";

import { canonicalise, hash, parse, parseOrThrow, print, type SpecNode } from "../src/index";
import { generateSpec, rng } from "./generate";

const ITERATIONS = 500;
const SEED = 0x706c6467; // "pldg"

describe("round-trip", () => {
  it(`is a fixed point over ${ITERATIONS} generated specs (seed ${SEED})`, () => {
    const random = rng(SEED);
    let checked = 0;

    for (let i = 0; i < ITERATIONS; i += 1) {
      const source = generateSpec(random);
      const first = parse(source);
      // The generator only emits specs the catalogue admits; a rejection is a generator bug or
      // a real parser bug, and either way the spec that caused it belongs in the message.
      expect(first.ok, `${source}\n${first.ok ? "" : JSON.stringify(first.issues, null, 2)}`).toBe(true);
      if (!first.ok) continue;

      const canonical = canonicalise(first.ast);
      const printed = print(canonical);

      const second = parse(printed);
      expect(second.ok, `re-parse failed for ${printed}`).toBe(true);
      if (!second.ok) continue;

      const again = canonicalise(second.ast);
      expect(again, `AST drifted:\n  ${source}\n  ${printed}`).toEqual(canonical);
      expect(print(again), `source drifted:\n  ${printed}`).toBe(printed);
      expect(hash(again), `hash drifted for ${printed}`).toBe(hash(canonical));
      checked += 1;
    }

    expect(checked).toBe(ITERATIONS);
  });

  it("generates a varied corpus rather than the same spec 500 times", () => {
    // A generator that degenerates would make the property above vacuous. This is the guard.
    const random = rng(SEED);
    const seen = new Set<string>();
    for (let i = 0; i < ITERATIONS; i += 1) seen.add(generateSpec(random));
    expect(seen.size).toBeGreaterThan(ITERATIONS * 0.9);
  });

  it("prints parentheses wherever re-parsing would re-associate", () => {
    // §5 step 1 left-associates rather than flattening, so these are two different trees. Each
    // has to survive its own round-trip, and they must not converge onto one hash.
    const left = canonicalise(
      parseOrThrow('(dns("a.io").resolves and dns("b.io").resolves) and dns("c.io").resolves'),
    );
    const right = canonicalise(
      parseOrThrow('dns("a.io").resolves and (dns("b.io").resolves and dns("c.io").resolves)'),
    );

    for (const tree of [left, right]) {
      expect(canonicalise(parseOrThrow(print(tree)))).toEqual(tree);
    }
    expect(hash(left)).not.toBe(hash(right));
  });

  it("keeps an integral decimal a decimal", () => {
    // `2.0` printed as `2` would re-lex as an integer and the fixed point would break silently
    // for exactly one literal shape. No catalogue field is a decimal today, so the printer is
    // the only thing standing between that and the first one that is.
    const comparison = parseOrThrow('http("https://a.io").status == 200');
    if (comparison.kind !== "compare") throw new Error("should parse to a comparison");
    const withDecimal: SpecNode = { ...comparison, right: { type: "decimal", value: 2 } };
    expect(print(withDecimal)).toContain("2.0");
  });
});
