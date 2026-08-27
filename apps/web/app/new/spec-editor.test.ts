/**
 * The picker is wired to `@pledge/spec`'s table, not to a copy of it.
 *
 * The audit that produced this phase found the five templates unit-tested and imported by
 * nothing, so the assertion that matters here is a rendering one: every label in the §9 table
 * reaches the form, and the escape hatch out of it opens on the expansion rather than empty.
 *
 * No JSX — see ./spec-preview.test.ts.
 */
import { TEMPLATES, getTemplate } from "@pledge/spec";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SpecEditor } from "./spec-editor";

const noop = () => undefined;

function render(over: Partial<Parameters<typeof SpecEditor>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(SpecEditor, {
      templateId: "release_version",
      values: {},
      raw: null,
      source: "",
      onTemplate: noop,
      onValue: noop,
      onRaw: noop,
      ...over,
    }),
  );
}

describe("SpecEditor", () => {
  it("offers every §9 template", () => {
    const html = render();
    for (const template of TEMPLATES) {
      expect(html).toContain(template.label);
    }
  });

  it("renders the selected template's blanks, with their hints", () => {
    const template = getTemplate("publish_package");
    const html = render({ templateId: "publish_package" });
    for (const blank of template.blanks) {
      expect(html).toContain(blank.label);
      expect(html).toContain(blank.placeholder);
    }
    // §4.1's warning, in front of the person filling the blank rather than only in the preview.
    expect(html).toContain("semver");
  });

  it("hands the escape hatch the current expansion rather than a blank page", () => {
    const source = 'github.pr("owner/name", 42).state == "merged"';
    const html = render({ raw: source, source });
    expect(html).toContain("&quot;merged&quot;");
    expect(html).toContain("<textarea");
  });
});
