/**
 * The preview is the whole point of this phase: `@pledge/spec` running in the browser, on the
 * bytes the user is typing, producing the hash that will actually be stored (CLAUDE.md I-6).
 *
 * So this renders the component for real rather than testing the helpers around it. No JSX —
 * the web tsconfig sets `jsx: "preserve"` for Next, and `createElement` sidesteps needing a
 * second transform configuration for one test file.
 */
import { compile } from "@pledge/spec";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SpecPreview } from "./spec-preview";

function render(source: string): string {
  return renderToStaticMarkup(createElement(SpecPreview, { result: compile(source) }));
}

describe("SpecPreview", () => {
  it("shows the resolved DSL source, the probe class and the content address", () => {
    const source = 'github.release("owner/name").tag matches "v0.1.*"';
    const compiled = compile(source);
    if (!compiled.ok) throw new Error("fixture did not compile");

    const html = render(source);
    // §5.1: the canonical rendering, which is what the probe evaluates — not the template's
    // friendly label, and not necessarily the characters that were typed.
    expect(html).toContain(compiled.spec.dslSource.replace(/"/g, "&quot;"));
    expect(html).toContain(compiled.spec.hash);
    expect(html).toContain(compiled.spec.probeClass);
  });

  it("shows the resolved comparison mode for a version comparison (§4.1)", () => {
    expect(render('npm("p").latest_version >= v0.2.0')).toContain("compared as a version");
    expect(render('npm("p").latest_version >= v0.9')).toContain("compared as text");
  });

  it("does not accuse an untouched form of a syntax error", () => {
    // A template with empty blanks expands to something that cannot parse. Showing that as a
    // parse error on first paint teaches people to ignore the panel that matters later.
    const html = renderToStaticMarkup(
      createElement(SpecPreview, { result: compile("github.release(…).tag"), pending: true }),
    );
    expect(html).not.toContain("does not parse");
    expect(html).toContain("before you commit");
  });

  it("points at the offending character instead of saying 'syntax error'", () => {
    const html = render('http("https://example.com").stats == 200');
    expect(html).toContain("character");
    expect(html).not.toContain("What you are promising");
  });
});
