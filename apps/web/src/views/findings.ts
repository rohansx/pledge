import { h } from "../dom.ts";
import { when } from "../format.ts";
import { replayCommand, type AppModel, type Finding } from "../model.ts";
import { href } from "../routes.ts";
import { seedSquares } from "./list.ts";
import { evidence } from "./scan.ts";

function copyButton(text: string): HTMLElement {
  const button = h("button", { class: "icon-btn", type: "button", onclick: () => void navigator.clipboard?.writeText(text).then(() => { button.textContent = "Copied"; }) }, "Copy");
  return button;
}

/** A broken pledge as something to act on: what broke, under what, how often, and how to see it again. */
export function findingBlock(app: string, finding: Finding, withEvidence: boolean): HTMLElement {
  const { pledge, scan } = finding;
  const seeds = pledge.seeds.length;
  const command = replayCommand(finding);
  const blocks = pledge.status === "approved";
  return h(
    "article",
    { class: "finding" },
    h(
      "div",
      { class: "finding-top" },
      h("span", { class: "stamp broken" }, "broken"),
      h("span", { class: "finding-where" }, `${scan.scenario}, ${scan.scan.faults ? `under ${scan.scan.faults.name}` : "with no faults"}, ${when(scan.created_at)}`),
      seedSquares(pledge.seeds.map((seed) => seed.status)),
    ),
    h("h3", {}, h("a", { href: href(app, "pledges", `${scan.scenario}:${pledge.id}`) }, pledge.statement)),
    h(
      "p",
      { class: "finding-say" },
      `Broke on ${finding.brokenSeeds.length} of ${seeds} ${seeds === 1 ? "seed" : "seeds"} (${finding.brokenSeeds.map((seed) => `seed ${seed}`).join(", ")}). `,
      blocks ? "This pledge is approved, so it would fail a pull request check." : `This pledge is ${pledge.status}, not approved, so it does not block anything yet.`,
    ),
    scan.scan.faults?.description ? h("p", { class: "finding-fault" }, h("b", {}, "The fault: "), scan.scan.faults.description) : null,
    withEvidence ? evidence(pledge) : null,
    h("div", { class: "replay" }, h("span", {}, "Replay one seed"), h("code", {}, command), copyButton(command)),
    h("p", { class: "finding-links" }, h("a", { href: href(app, "scans", scan.id) }, "Open the scan"), h("a", { href: href(app, "pledges", `${scan.scenario}:${pledge.id}`) }, "Open the pledge")),
  );
}

export function findingsView(model: AppModel): HTMLElement {
  return h(
    "div",
    { class: "wrap" },
    h("h1", {}, "Findings"),
    h("p", { class: "lede" }, "A finding is a pledge that broke in the latest scan of its scenario. Each one names the seeds it broke on and the command that shows it again."),
    model.findings.length === 0
      ? h("div", { class: "empty" }, h("p", {}, "Nothing is broken in the latest scans."), h("p", {}, "That covers only the faults those scans injected. A scan under a different fault plan may find something."))
      : h("div", { class: "findings" }, ...model.findings.map((finding) => findingBlock(model.app, finding, true))),
  );
}
