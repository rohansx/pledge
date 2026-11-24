import { h } from "../dom.ts";
import { plural, when } from "../format.ts";
import { standing, type AppModel } from "../model.ts";
import { href } from "../routes.ts";
import { findingBlock } from "./findings.ts";
import { scanRow, seedSquares } from "./list.ts";

function figure(value: number | string, label: string, tone = ""): HTMLElement {
  return h("div", { class: `figure ${tone}` }, h("b", {}, String(value)), h("span", {}, label));
}

/** One block per current scan: every pledge it checked as a row, every seed as a square. */
function matrix(model: AppModel): HTMLElement[] {
  return model.current.map((stored) =>
    h(
      "section",
      { class: "matrix" },
      h(
        "a",
        { class: "matrix-head", href: href(model.app, "scans", stored.id) },
        h("b", {}, stored.scenario),
        h("span", {}, stored.scan.faults ? `under ${stored.scan.faults.name}` : "no faults (baseline)"),
        h("span", { class: "matrix-when" }, `${plural(stored.scan.runs.length, "seed")}, ${when(stored.created_at)}`),
      ),
      ...[...stored.scan.pledges]
        .sort((a, b) => Number(b.result === "broken") - Number(a.result === "broken"))
        .map((pledge) =>
          h(
            "a",
            { class: `matrix-row${pledge.result === "broken" ? " is-broken" : ""}`, href: href(model.app, "pledges", `${stored.scenario}:${pledge.id}`) },
            h("span", { class: "matrix-say" }, pledge.statement),
            seedSquares(pledge.seeds.map((seed) => seed.status)),
            h("span", { class: `matrix-tally ${pledge.result}` }, pledge.broken > 0 ? `broken ${pledge.broken} of ${pledge.seeds.length}` : pledge.result === "kept" ? "kept" : "unclear"),
          ),
        ),
    ),
  );
}

export function overviewView(model: AppModel): HTMLElement {
  const state = standing(model);
  const { counts } = model;
  if (state.word === "empty") {
    return h("div", { class: "wrap" }, h("h1", {}, model.app), h("div", { class: "empty" }, h("p", {}, state.sentence), h("p", {}, "Publish a scan with ", h("code", {}, "pledge scan <app> --scenario <name> --faults <file> --publish"), ".")));
  }
  return h(
    "div",
    { class: "wrap" },
    h(
      "section",
      { class: "head texture ticks" },
      h("div", {}, h("span", { class: `stamp ${state.word}` }, state.word), h("h1", {}, model.app), h("p", { class: "head-say" }, state.sentence)),
      h(
        "div",
        { class: "figures" },
        figure(counts.pledges, plural(counts.pledges, "pledge").replace(/^\d+ /, "")),
        figure(counts.broken, "broken", counts.broken > 0 ? "bad" : ""),
        figure(counts.kept, "kept", "good"),
        figure(counts.approved, "approved"),
        figure(counts.seeds, "seeds run"),
        figure(counts.faultsInjected, "faults injected"),
      ),
    ),

    h("h2", {}, "Pledges by seed", h("small", {}, "the latest scan of each scenario; one square is one seed")),
    ...matrix(model),

    ...(model.findings.length > 0
      ? [
          h("h2", {}, "Findings", h("small", {}, h("a", { class: "more", href: href(model.app, "findings") }, `all ${model.findings.length}`))),
          ...model.findings.slice(0, 2).map((finding) => findingBlock(model.app, finding, false)),
        ]
      : []),

    h("h2", {}, "Recent scans", h("small", {}, h("a", { class: "more", href: href(model.app, "scans") }, `all ${model.scans.length}`))),
    h("div", { class: "ledger flush" }, ...model.scans.slice(0, 4).map((scan) => scanRow(scan, href(model.app, "scans", scan.id)))),
  );
}
