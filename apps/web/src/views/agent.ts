import { h } from "../dom.ts";
import { seconds, thousands, when } from "../format.ts";
import type { AppModel } from "../model.ts";
import { href } from "../routes.ts";
import { authoringReport } from "./scan.ts";

export function agentView(model: AppModel): HTMLElement {
  const runs = model.agentRuns;
  return h(
    "div",
    { class: "wrap" },
    h("h1", {}, "Agent runs"),
    h("p", { class: "lede" }, "Each time Claude booted this app in a sandbox and wrote its scenarios, pledges and fault files. Claude writes; checks in the sandbox decide whether each phase is accepted, and it cannot approve its own pledges."),
    runs.length === 0
      ? h("div", { class: "empty" }, h("p", {}, "No scan of this app was authored by Claude."), h("p", {}, "Run ", h("code", {}, "pledge author <repo> --out <dir>"), ", then scan and publish from that directory."))
      : h(
          "div",
          {},
          ...runs.flatMap((run) => {
            const tokens = run.authoring.phases.reduce((sum, phase) => sum + phase.tokens, 0);
            return [
              h("h2", {}, `Authored ${when(run.at)}`, h("small", {}, `${seconds(run.authoring.seconds)}, ${thousands(tokens)} tokens, wrote ${run.scenarios.join(", ")}`), h("small", {}, h("a", { class: "more", href: href(model.app, "scans", run.scanId) }, "a scan from this run"))),
              ...authoringReport(run.authoring),
            ];
          }),
        ),
  );
}
