import type { Scan, ScanPledge, ScanSeed, StoredScan } from "../api.ts";
import { h } from "../dom.ts";
import { checkRows, plain, pledgeCount, plural, seconds, thousands, verdictSentence, when } from "../format.ts";
import { seedSquares } from "./list.ts";

const ORDER = { broken: 0, inconclusive: 1, kept: 2 };

function head(stored: StoredScan): HTMLElement {
  const { scan } = stored;
  const broken = scan.pledges.filter((pledge) => pledge.result === "broken").length;
  const approved = scan.pledges.filter((pledge) => pledge.status === "approved").length;
  const timing = scan.sandbox?.seconds ?? {};
  const facts: [string, string][] = [
    ["scanned", when(stored.created_at)],
    ["journeys per seed", String(scan.runs[0]?.journeys ?? 0)],
    ["faults injected", String(scan.runs.reduce((sum, run) => sum + run.faults_injected, 0))],
  ];
  if (scan.sandbox) facts.push(["outbound network", scan.sandbox.outbound_blocked ? "closed" : "open"]);
  if (timing.total !== undefined) facts.push(["whole scan", seconds(timing.total)]);
  for (const [name, value] of Object.entries(scan.env)) facts.push([name, value]);

  return h(
    "section",
    { class: "head texture ticks" },
    h(
      "div",
      {},
      h("span", { class: `stamp ${scan.verdict}` }, scan.verdict),
      h("h1", {}, scan.app, h("span", {}, " / "), scan.scenario),
      h("p", { class: "head-say" }, verdictSentence(scan.verdict, scan.pledges.length, broken, approved)),
    ),
    h("div", { class: "head-seeds" }, seedSquares(scan.runs.map((run) => run.verdict), true), h("p", {}, `${plural(scan.runs.length, "seed")}, one square each`)),
    h("div", { class: "facts" }, ...facts.map(([name, value]) => h("span", {}, `${name} `, h("b", {}, value)))),
  );
}

export function evidence(pledge: ScanPledge): HTMLElement {
  const rows: HTMLElement[] = [];
  for (const seed of pledge.seeds) {
    const checks = seed.expected === undefined && seed.actual === undefined ? [] : checkRows(seed.expected, seed.actual);
    const label = (first: boolean) => (first ? h("td", { class: "seed-cell", rowspan: Math.max(checks.length, 1) }, h("i", { class: seed.status }), `seed ${seed.seed}`) : null);
    if (checks.length === 0) {
      rows.push(h("tr", {}, label(true), h("td", { class: "key", colspan: 3 }, note(seed))));
      continue;
    }
    checks.forEach((check, index) =>
      rows.push(h("tr", { class: check.differs && seed.status === "fail" ? "differs" : "" }, label(index === 0), h("td", { class: "key" }, check.key || (seed.failed ? `per journey; ${seed.failed} failed` : "value")), h("td", {}, check.expected), h("td", { class: "actual" }, check.actual))),
    );
  }
  return h(
    "div",
    { class: "evidence" },
    h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "Seed"), h("th", {}, "Checked"), h("th", {}, "Expected"), h("th", {}, "Actual"))), h("tbody", {}, ...rows)),
    h("p", { class: "note" }, `Engine assertion ${pledge.assertion}. Each seed's full evidence is in its run directory, ${pledge.seeds[0]?.run_id ?? ""} and the others listed under Runs.`),
  );
}

function note(seed: ScanSeed): string {
  if (seed.status === "pass") return "held; the engine keeps expected and actual values only for checks that fail";
  if (seed.status === "fail") return seed.failed ? `failed for ${seed.failed} journeys` : "failed";
  return "could not be judged on this seed";
}

function pledgeRow(pledge: ScanPledge, open: boolean): HTMLElement {
  const container = h("div", { class: `pledge${pledge.result === "broken" ? " is-broken" : ""}` });
  const panel = evidence(pledge);
  panel.hidden = !open;
  const button = h(
    "button",
    {
      type: "button",
      "aria-expanded": String(open),
      onclick: () => {
        panel.hidden = !panel.hidden;
        button.setAttribute("aria-expanded", String(!panel.hidden));
      },
    },
    h(
      "span",
      {},
      h("span", { class: "pledge-say" }, pledge.statement),
      h(
        "span",
        { class: "pledge-meta" },
        h("span", { class: `state ${pledge.status}` }, pledge.status),
        h("span", {}, pledge.id),
        h("span", {}, `source: ${pledge.source.replace("_", " ")}`),
        pledge.confidence ? h("span", {}, `confidence: ${pledge.confidence}`) : null,
      ),
    ),
    seedSquares(pledge.seeds.map((seed) => seed.status)),
    h(
      "span",
      { class: "pledge-tally" },
      pledge.broken > 0 ? h("b", { class: "broken" }, `broken ${pledge.broken}`) : h("b", { class: "kept" }, `kept ${pledge.kept}`),
      pledge.broken > 0 && pledge.kept > 0 ? ` · kept ${pledge.kept}` : "",
      pledge.unknown > 0 ? ` · unknown ${pledge.unknown}` : "",
    ),
  );
  container.append(button, panel);
  return container;
}

/** JSON with keys, strings and numbers coloured, built from text nodes. */
function code(value: unknown, indent = 0): (Node | string)[] {
  const pad = "  ".repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return ["[]"];
    return ["[\n", ...value.flatMap((item, index) => [pad + "  ", ...code(item, indent + 1), index < value.length - 1 ? ",\n" : "\n"]), pad + "]"];
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) return ["{}"];
    return ["{\n", ...entries.flatMap(([key, item], index) => [pad + "  ", h("span", { class: "key" }, JSON.stringify(key)), ": ", ...code(item, indent + 1), index < entries.length - 1 ? ",\n" : "\n"]), pad + "}"];
  }
  return [h("span", { class: typeof value === "string" ? "str" : "num" }, JSON.stringify(value))];
}

function plan(scan: Scan): HTMLElement[] {
  if (!scan.faults) return [h("h2", {}, "Fault plan"), h("p", { class: "lede" }, "None. This was a baseline: the scenario ran with no faults injected.")];
  return [
    h("h2", {}, "Fault plan", h("small", {}, "the same faults on every seed; the seed picks which requests they hit")),
    h(
      "div",
      { class: "plan" },
      h("div", { class: "plan-say" }, h("b", {}, scan.faults.name), scan.faults.description || "No description."),
      h("pre", { class: "code texture" }, ...code(scan.faults.faults)),
    ),
  ];
}

function runs(scan: Scan): HTMLElement[] {
  return [
    h("h2", {}, "Runs", h("small", {}, "one sandbox fork per seed")),
    h(
      "div",
      { class: "scroll" },
      h(
        "table",
        { class: "table" },
        h("thead", {}, h("tr", {}, h("th", {}, "Seed"), h("th", {}, "Engine verdict"), h("th", { class: "num" }, "Journeys"), h("th", { class: "num" }, "Faults injected"), h("th", {}, "Run directory"), h("th", {}, "Limitations"))),
        h(
          "tbody",
          {},
          ...scan.runs.map((run) =>
            h("tr", {}, h("td", {}, String(run.seed)), h("td", { class: run.verdict }, run.verdict), h("td", { class: "num" }, String(run.journeys)), h("td", { class: "num" }, String(run.faults_injected)), h("td", {}, run.run_id), h("td", {}, run.limitations.join("; ") || "none")),
          ),
        ),
      ),
    ),
  ];
}

/** The phases table, the model's own summary and its questions for a reviewer. */
export function authoringReport(report: NonNullable<Scan["authoring"]>): HTMLElement[] {
  return [
    h(
      "div",
      { class: "scroll" },
      h(
        "table",
        { class: "table" },
        h("thead", {}, h("tr", {}, h("th", {}, "Phase"), h("th", {}, "Model"), h("th", { class: "num" }, "Requests"), h("th", { class: "num" }, "Tokens"), h("th", { class: "num" }, "From cache"), h("th", { class: "num" }, "Output"), h("th", { class: "num" }, "Commands"), h("th", { class: "num" }, "Time"), h("th", { class: "num" }, "Rejected"))),
        h(
          "tbody",
          {},
          ...report.phases.map((phase) =>
            h("tr", {}, h("td", {}, phase.phase), h("td", {}, phase.model), h("td", { class: "num" }, String(phase.requests)), h("td", { class: "num" }, thousands(phase.tokens)), h("td", { class: "num" }, thousands(phase.cache_read_tokens)), h("td", { class: "num" }, thousands(phase.output_tokens)), h("td", { class: "num" }, String(phase.commands)), h("td", { class: "num" }, seconds(phase.seconds)), h("td", { class: "num" }, String(phase.rejected_finishes))),
          ),
        ),
      ),
    ),
    h("p", { class: "prose" }, plain(report.summary)),
    report.open_questions.length > 0 ? h("ul", { class: "questions" }, ...report.open_questions.map((question) => h("li", {}, plain(question)))) : h("p", { class: "prose" }, "It raised no questions for a reviewer."),
  ];
}

function authoring(scan: Scan): HTMLElement[] {
  const report = scan.authoring;
  if (!report) return [];
  return [
    h("h2", {}, "Written by Claude", h("small", {}, `scenario, pledges and faults authored in ${seconds(report.seconds)}; checks in the sandbox accepted each phase`)),
    ...authoringReport(report),
  ];
}

export function scanView(stored: StoredScan, backHref: string): HTMLElement {
  const { scan } = stored;
  const pledges = [...scan.pledges].sort((a, b) => ORDER[a.result] - ORDER[b.result]);
  const broken = pledges.filter((pledge) => pledge.result === "broken").length;
  return h(
    "div",
    { class: "wrap" },
    h("a", { class: "back", href: backHref }, "← All scans"),
    head(stored),
    h("h2", {}, "Pledges", h("small", {}, `${pledgeCount(pledges.length, broken)}; select one for expected against actual`)),
    ...pledges.map((pledge, index) => pledgeRow(pledge, pledge.result === "broken" && index === 0)),
    ...plan(scan),
    ...runs(scan),
    ...authoring(scan),
  );
}
