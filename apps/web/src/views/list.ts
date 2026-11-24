import type { ScanSummary } from "../api.ts";
import { h } from "../dom.ts";
import { pledgeCount, seedsCount, when } from "../format.ts";

export function seedSquares(verdicts: string[], large = false): HTMLElement {
  const label = seedsCount(verdicts);
  return h("span", { class: large ? "seeds lg" : "seeds", role: "img", "aria-label": label, title: label }, ...verdicts.map((verdict) => h("i", { class: verdict === "inconclusive" ? "" : verdict })));
}

export function scanRow(scan: ScanSummary, href: string): HTMLElement {
  return h(
    "a",
    { class: `scan-row${scan.verdict === "broken" || scan.broken > 0 ? " is-broken" : ""}`, href },
    h("span", {}, h("span", { class: `stamp ${scan.verdict}` }, scan.verdict)),
    h(
      "span",
      {},
      h("span", { class: "scan-name" }, scan.app, h("span", {}, " / "), scan.scenario),
      h("div", { class: "scan-sub" }, scan.faults ? `under ${scan.faults}` : "no faults (baseline)", scan.authored ? ", written by Claude" : ""),
    ),
    h("span", { class: "scan-count" }, scan.broken > 0 ? h("b", {}, pledgeCount(scan.pledges, scan.broken)) : pledgeCount(scan.pledges, scan.broken)),
    seedSquares(scan.run_verdicts),
    h("span", { class: "scan-when" }, when(scan.created_at)),
  );
}

export function listView(scans: ScanSummary[], hrefFor: (scan: ScanSummary) => string): HTMLElement {
  const body =
    scans.length === 0
      ? h(
          "div",
          { class: "empty" },
          h("p", {}, "No scans have been published yet."),
          h("p", {}, "Run one and send it here with ", h("code", {}, "pledge scan <app> --scenario <name> --faults <file> --publish"), "."),
        )
      : h("div", { class: "ledger" }, ...scans.map((scan) => scanRow(scan, hrefFor(scan))));
  return h(
    "div",
    { class: "wrap" },
    h("h1", {}, "Scans"),
    h("p", { class: "lede" }, "Each scan boots an app once in a sandbox, runs it under a fault plan on several seeds, and counts which pledges held. One square is one seed."),
    body,
  );
}
