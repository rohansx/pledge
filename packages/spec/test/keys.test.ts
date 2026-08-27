/**
 * done-spec-dsl.md §6.2 — the evidence key, and the one way it can lie.
 *
 * `targetKey` joins "what was observed" to "what the spec asked for". It is built by
 * concatenation — `source+name=value`, no escaping, because §6.2 wants a key that reads back as
 * the accessor a human authored. That only holds if the separators cannot appear in a value.
 * They could: modifier arguments were NFC-normalised and otherwise unconstrained, so
 *
 *     github.commits("o/r").by("alice").on_branch("main")
 *     github.commits("o/r").by("alice+on_branch=main")
 *
 * hashed differently — two specs — and produced ONE key. Inside a single spec that is two leaves
 * resolved against each other's evidence, which is the failure mode the whole product exists to
 * make impossible. The fix is at parse time, on the charset, not on the key shape.
 */
import { describe, expect, it } from "vitest";

import { compile, parseOrThrow, targetKey, type Instants, type SpecNode } from "../src/index";

const INSTANTS: Instants = {
  commitTime: new Date("2026-09-01T00:00:00.000Z"),
  deadline: new Date("2026-09-08T00:00:00.000Z"),
};

/** Every targetKey a spec would ask the worker to fetch. */
function targetKeys(source: string): string[] {
  const keys: string[] = [];
  const walk = (node: SpecNode): void => {
    switch (node.kind) {
      case "and":
      case "or":
        walk(node.left);
        walk(node.right);
        return;
      case "not":
        walk(node.operand);
        return;
      case "compare":
        keys.push(targetKey(node.left, INSTANTS));
        return;
      case "truthy":
        keys.push(targetKey(node.accessor, INSTANTS));
    }
  };
  walk(parseOrThrow(source));
  return keys;
}

describe("evidence keys cannot be forged through a string argument", () => {
  it("refuses a modifier argument carrying the key's own separators", () => {
    // The confirmed collision, both halves of it.
    const smuggled = compile('github.commits("o/r").by("alice+on_branch=main").count >= 1');
    expect(smuggled.ok).toBe(false);
    if (smuggled.ok) throw new Error("unreachable");
    expect(smuggled.issues.map((i) => i.message).join()).toMatch(/login may contain only/);

    // The spec it would have impersonated is still perfectly legal.
    const honest = compile('github.commits("o/r").by("alice").on_branch("main").count >= 1');
    expect(honest.ok).toBe(true);
    expect(targetKeys('github.commits("o/r").by("alice").on_branch("main").count >= 1')).toEqual([
      "github.commits:o/r+by=alice+on_branch=main",
    ]);
  });

  it("refuses the same trick through on_branch and through a workflow name", () => {
    // `on_branch` is the mirror of `by`. The workflow NAME is the sibling caller: it is a
    // catalogue `string` param too, it lands in the key as `github.workflow:o/r:<name>`, and
    // `github.workflow` carries a `.since()` modifier — so a `+since=<deadline>` in the name
    // reproduces the collision one source over.
    const deadline = INSTANTS.deadline.toISOString();
    const rejected = [
      'github.commits("o/r").on_branch("main+by=alice").count >= 1',
      `github.workflow("o/r", "ci+since=${deadline}").success_count >= 1`,
      'github.commits("o/r").by("a,b").count >= 1',
      'github.commits("o/r").by("a=b").count >= 1',
    ];
    for (const source of rejected) {
      expect(compile(source).ok, `${source} should be rejected`).toBe(false);
    }

    // And the pair it would have collided with is genuinely two keys, not one.
    const keys = targetKeys(
      `github.workflow("o/r", "ci").since(deadline).success_count >= 1 and ` +
        `github.workflow("o/r", "ci").success_count >= 1`,
    );
    expect(new Set(keys).size).toBe(2);
  });

  it("still admits the names people actually write", () => {
    for (const source of [
      'github.commits("o/r").on_branch("release/1.2").count >= 1',
      'github.commits("o/r").on_branch("feat/my_thing.v2-b").count >= 1',
      'github.commits("o/r").by("some-user").count >= 1',
      'github.workflow("o/r", "release.yml").latest_conclusion == "success"',
      'github.workflow("o/r", "CI build").latest_conclusion == "success"',
    ]) {
      expect(compile(source).ok, `${source} should parse`).toBe(true);
    }
  });
});

describe("glob character classes that read as negation", () => {
  it("warns rather than silently matching the opposite (§4.3)", () => {
    for (const pattern of ["v[!0-9].*", "v[^0-9].*", "{a,[!b]}*"]) {
      const result = compile(`http("https://a.io").text matches "${pattern}"`);
      expect(result.ok, `${pattern} stays legal`).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(
        result.spec.warnings.map((w) => w.code),
        `${pattern} should warn`,
      ).toContain("glob_class_negation");
    }
  });

  it("does not warn on a class that is not pretending to be one", () => {
    for (const pattern of ["v[0-9].*", "v[a!].*", "*"]) {
      const result = compile(`http("https://a.io").text matches "${pattern}"`);
      if (!result.ok) throw new Error(`${pattern} should parse`);
      expect(result.spec.warnings.map((w) => w.code)).not.toContain("glob_class_negation");
    }
  });
});
