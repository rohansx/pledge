import { h, mark } from "./dom.ts";
import { when } from "./format.ts";
import type { AppModel } from "./model.ts";
import { href, type Page } from "./routes.ts";

const TITLES: Record<Page, string> = { overview: "Overview", findings: "Findings", pledges: "Pledges", scans: "Scans", agent: "Agent runs", settings: "Settings" };

export interface ShellOptions {
  apps: string[];
  model: AppModel | null;
  page: Page;
  crumb: string | null; // a third level, such as a pledge id
  onSwitchApp: (app: string) => void;
  onRefresh: () => void;
  onToggleTheme: () => void;
  onSignOut: () => void;
}

function navLink(app: string, page: Page, current: Page, count: number | null, alert = false): HTMLElement {
  return h(
    "a",
    { class: "side-link", href: href(app, page), "aria-current": page === current ? "page" : null },
    TITLES[page],
    count === null ? null : h("span", { class: `side-count${alert && count > 0 ? " alert" : ""}` }, String(count)),
  );
}

export function shell(options: ShellOptions, content: HTMLElement): HTMLElement {
  const { model, page } = options;
  const app = model?.app ?? null;
  const side = h("aside", { class: "side", id: "side" });

  const switcher =
    options.apps.length > 0
      ? h(
          "label",
          { class: "side-app" },
          h("span", {}, "App"),
          h(
            "select",
            { onchange: (event: Event) => options.onSwitchApp((event.target as HTMLSelectElement).value) },
            ...options.apps.map((name) => h("option", { value: name, selected: name === app }, name)),
          ),
        )
      : null;

  const nav = app && model
    ? h(
        "nav",
        { class: "side-nav", "aria-label": "Sections" },
        navLink(app, "overview", page, null),
        navLink(app, "findings", page, model.findings.length, true),
        navLink(app, "pledges", page, model.counts.pledges),
        navLink(app, "scans", page, model.scans.length),
        navLink(app, "agent", page, model.agentRuns.length),
      )
    : null;

  side.append(
    h("a", { class: "logo", href: app ? href(app, "overview") : "#/", "aria-label": "Pledge, overview" }, mark(20), "pledge"),
    ...(switcher ? [switcher] : []),
    ...(nav ? [nav] : []),
    h(
      "div",
      { class: "side-foot" },
      app ? h("a", { class: "side-link", href: href(app, "settings"), "aria-current": page === "settings" ? "page" : null }, "Settings") : null,
      h(
        "div",
        { class: "account" },
        h("span", { class: "avatar", "aria-hidden": "true" }, "T"),
        h("span", { class: "account-who" }, h("b", {}, "Access token"), h("small", {}, "shared, until sign-in is set up")),
      ),
      h(
        "div",
        { class: "account-actions" },
        h("button", { class: "icon-btn theme", type: "button", "aria-label": "Switch between light and dark", onclick: options.onToggleTheme }, h("span", { class: "sun" }, "☀"), h("span", { class: "moon" }, "☾")),
        h("button", { class: "icon-btn", type: "button", onclick: options.onSignOut }, "Sign out"),
      ),
    ),
  );

  const latest = model?.scans[0];
  const top = h(
    "header",
    { class: "top" },
    h("button", { class: "icon-btn menu", type: "button", "aria-controls": "side", "aria-label": "Open the menu", onclick: () => side.classList.toggle("open") }, "Menu"),
    h("p", { class: "crumbs" }, app ? h("span", {}, app) : null, app ? h("i", {}, "/") : null, h("b", {}, TITLES[page]), options.crumb ? h("i", {}, "/") : null, options.crumb ? h("span", {}, options.crumb) : null),
    h("span", { class: "top-end" }, latest ? h("span", { class: "top-when" }, `last scan ${when(latest.created_at)}`) : null, h("button", { class: "icon-btn", type: "button", onclick: options.onRefresh }, "Refresh")),
  );

  // A tap on a link in the open menu closes it again on small screens.
  side.addEventListener("click", (event) => {
    if ((event.target as HTMLElement).closest("a")) side.classList.remove("open");
  });
  // On small screens the open menu covers the page; a tap on the page behind it closes it.
  const main = h("main", { onclick: () => side.classList.remove("open") }, content);
  return h("div", { class: "shell" }, side, h("div", { class: "main" }, top, main));
}
