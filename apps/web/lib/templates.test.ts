/**
 * The five template expansions, pinned against done-spec-dsl.md §9.
 *
 * §9's table is normative: users pick the left column and get the right column, and the right
 * column is what gets canonicalised and hashed. So these assertions are transcriptions of the
 * document, not descriptions of the code — if an expansion here has to change to make a test
 * pass, the change belongs in the document first.
 *
 * The freshness clause is asserted separately and deliberately. §9: "Every template includes a
 * `> commit_time` freshness clause where the source supports one... this is the single most
 * likely accidental (rather than adversarial) false pass." Dropping one would be invisible in
 * a rendered preview and catastrophic in a record.
 */
import { describe, expect, it } from "vitest";
import { TEMPLATES, getTemplate, isComplete, quote, templateIds } from "./templates";

describe("templates — §9 expansions", () => {
  it("Release a version", () => {
    expect(
      getTemplate("release_version").expand({ repo: "owner/name", tag: "v0.1.*" }),
    ).toBe(
      'github.release("owner/name").tag matches "v0.1.*"' +
        ' and github.release("owner/name").published_at > commit_time',
    );
  });

  it("URL is live with content", () => {
    expect(
      getTemplate("url_live_with_content").expand({
        url: "https://example.com/changelog",
        content: "v0.1.0",
      }),
    ).toBe(
      'http("https://example.com/changelog").status == 200' +
        ' and http("https://example.com/changelog").text contains "v0.1.0"' +
        ' and http("https://example.com/changelog").text.length > 2000',
    );
  });

  it("Publish a package", () => {
    expect(
      getTemplate("publish_package").expand({ package: "my-package", version: "v0.2.0" }),
    ).toBe(
      'npm("my-package").latest_version >= v0.2.0' +
        ' and npm("my-package").published_at > commit_time',
    );
  });

  it("Merge a PR", () => {
    expect(getTemplate("merge_pr").expand({ repo: "owner/name", number: "42" })).toBe(
      'github.pr("owner/name", 42).state == "merged"',
    );
  });

  it("Sustained work", () => {
    expect(getTemplate("sustained_work").expand({ repo: "owner/name", count: "20" })).toBe(
      'github.commits("owner/name").since(commit_time).count >= 20',
    );
  });
});

describe("templates — invariants of the set", () => {
  it("has exactly the five templates §9 lists", () => {
    expect(TEMPLATES).toHaveLength(5);
    expect(TEMPLATES.map((t) => t.id)).toEqual([...templateIds]);
  });

  it("carries a commit_time freshness clause wherever the source supports one", () => {
    // §9 qualifies it: "where the source supports one". Two templates have none in the table
    // and neither omission is an oversight.
    //
    //   url_live_with_content — `http()` has no publication timestamp (§3.1: status, text,
    //     final_url, header, json). There is nothing to compare against `commit_time`. Its
    //     protection against a page that was already live is the `.text contains` clause plus
    //     the baseline snapshot, not a freshness comparison.
    //   merge_pr — `.state == "merged"` is already a statement about the PR's current state.
    //
    // `sustained_work` carries `commit_time` as a `.since()` window rather than a comparison,
    // which is the same protection reached by a different route.
    const withFreshness = new Set(["release_version", "publish_package", "sustained_work"]);
    for (const template of TEMPLATES) {
      const source = template.expand(filled(template.blanks.map((b) => b.name)));
      expect(source.includes("commit_time")).toBe(withFreshness.has(template.id));
    }
  });

  it("renders every blank it declares, so no placeholder survives into a filled spec", () => {
    for (const template of TEMPLATES) {
      const values = filled(template.blanks.map((b) => b.name));
      expect(template.expand(values)).not.toContain("…");
    }
  });

  it("shows unfilled blanks as gaps rather than as empty literals", () => {
    // A half-filled preview must read as incomplete. `github.release("")` would look like a
    // valid spec against an empty repo.
    for (const template of TEMPLATES) {
      expect(template.expand({})).toContain("…");
      expect(isComplete(template, {})).toBe(false);
      expect(isComplete(template, filled(template.blanks.map((b) => b.name)))).toBe(true);
    }
  });

  it("rejects an unknown template id instead of falling back to another spec", () => {
    // Reachable from a stale URL parameter. A default here would expand to a criterion the
    // user did not choose.
    expect(() => getTemplate("no_such_template" as never)).toThrow();
  });
});

describe("quote", () => {
  it("emits a DSL string literal with JSON escapes, per the §2 grammar", () => {
    expect(quote("plain")).toBe('"plain"');
    expect(quote('has "quotes"')).toBe('"has \\"quotes\\""');
    expect(quote("back\\slash")).toBe('"back\\\\slash"');
  });

  it("escapes a control character rather than dropping it", () => {
    // Canonicalisation rejects control characters outright. Escaping keeps the preview honest
    // about what was typed so the rejection is legible; dropping it would hide the cause.
    expect(quote("a\nb")).toBe('"a\\nb"');
  });
});

/** Every named blank filled with a value that is obviously a value. */
function filled(names: readonly string[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (const name of names) {
    values[name] =
      name === "number" || name === "count"
        ? "7"
        : name === "version"
          ? "v1.0.0"
          : name === "url"
            ? "https://example.com"
            : name === "repo"
              ? "owner/name"
              : "x";
  }
  return values;
}
