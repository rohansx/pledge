import { h } from "../dom.ts";
import { when } from "../format.ts";
import type { AppModel, PledgeEntry } from "../model.ts";
import { href } from "../routes.ts";
import { seedSquares } from "./list.ts";
import { evidence } from "./scan.ts";

const FILTERS = ["all", "broken", "kept", "inconclusive"] as const;
type Filter = (typeof FILTERS)[number];

const key = (entry: PledgeEntry) => `${entry.scenario}:${entry.pledge.id}`;
const historyMarks = (entry: PledgeEntry) => entry.history.map((point) => (point.result === "broken" ? "fail" : point.result === "kept" ? "pass" : ""));

function row(app: string, entry: PledgeEntry): HTMLElement {
  const { pledge } = entry;
  return h(
    "a",
    { class: `pledge-line${pledge.result === "broken" ? " is-broken" : ""}`, href: href(app, "pledges", key(entry)) },
    h(
      "span",
      {},
      h("span", { class: "pledge-say" }, pledge.statement),
      h(
        "span",
        { class: "pledge-meta" },
        h("span", { class: `state ${pledge.status}` }, pledge.status),
        h("span", {}, entry.scenario),
        h("span", {}, `source: ${pledge.source.replace("_", " ")}`),
        pledge.confidence ? h("span", {}, `confidence: ${pledge.confidence}`) : null,
      ),
    ),
    h("span", { class: "pledge-history", title: "One square per scan, oldest first" }, seedSquares(historyMarks(entry))),
    h("span", { class: `matrix-tally ${pledge.result}` }, pledge.result === "broken" ? `broken ${pledge.broken} of ${pledge.seeds.length}` : pledge.result),
  );
}

export function pledgesView(model: AppModel): HTMLElement {
  const list = h("div", { class: "ledger flush" });
  const buttons = new Map<Filter, HTMLElement>();
  const show = (filter: Filter) => {
    const entries = model.pledges.filter((entry) => filter === "all" || entry.pledge.result === filter);
    list.replaceChildren(...(entries.length > 0 ? entries.map((entry) => row(model.app, entry)) : [h("p", { class: "none" }, `No pledge is ${filter} right now.`)]));
    for (const [name, button] of buttons) button.setAttribute("aria-pressed", String(name === filter));
  };
  const count = (filter: Filter) => (filter === "all" ? model.counts.pledges : model.counts[filter]);
  for (const filter of FILTERS) buttons.set(filter, h("button", { class: "chip", type: "button", onclick: () => show(filter) }, `${filter[0]!.toUpperCase()}${filter.slice(1)} `, h("b", {}, String(count(filter)))));
  show("all");
  return h(
    "div",
    { class: "wrap" },
    h("h1", {}, "Pledges"),
    h("p", { class: "lede" }, "Every statement about this app's data that a scan has checked, with its result in the latest scan and one square for each scan before it."),
    h("div", { class: "chips", role: "group", "aria-label": "Filter by result" }, ...buttons.values()),
    list,
  );
}

export function pledgeView(model: AppModel, id: string): HTMLElement {
  const entry = model.pledges.find((candidate) => key(candidate) === id);
  if (!entry) return h("div", { class: "wrap" }, h("a", { class: "back", href: href(model.app, "pledges") }, "← All pledges"), h("div", { class: "notice", role: "alert" }, "No scan of this app has checked a pledge with that name."));
  const { pledge } = entry;
  const facts: [string, string][] = [["status", pledge.status], ["scenario", entry.scenario], ["source", pledge.source.replace("_", " ")], ["confidence", pledge.confidence || "not given"], ["engine assertion", pledge.assertion]];
  return h(
    "div",
    { class: "wrap" },
    h("a", { class: "back", href: href(model.app, "pledges") }, "← All pledges"),
    h("span", { class: `stamp ${pledge.result}` }, pledge.result),
    h("h1", { class: "statement" }, pledge.statement),
    h("dl", { class: "facts-list" }, ...facts.flatMap(([name, value]) => [h("dt", {}, name), h("dd", {}, value)])),
    pledge.status === "approved" ? null : h("p", { class: "lede" }, `This pledge is ${pledge.status}. Only an approved pledge can fail a pull request check, and approving from the dashboard is not built yet: change "status" in .pledge/pledges/${pledge.id}.json.`),

    h("h2", {}, "Latest check", h("small", {}, h("a", { class: "more", href: href(model.app, "scans", entry.scanId) }, entry.faults ? `scan under ${entry.faults}` : "baseline scan"))),
    evidence(pledge),

    h("h2", {}, "History", h("small", {}, "every scan that checked this pledge, newest first")),
    h(
      "div",
      { class: "ledger flush" },
      ...[...entry.history].reverse().map((point) =>
        h("a", { class: "history-row", href: href(model.app, "scans", point.scanId) }, h("span", {}, h("span", { class: `stamp ${point.result}` }, point.result)), h("span", {}, point.faults ? `under ${point.faults}` : "no faults (baseline)"), h("span", { class: "scan-when" }, when(point.at))),
      ),
    ),
  );
}
