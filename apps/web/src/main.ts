import "./styles.css";

import { getScan, getToken, listScans, setToken, Unauthorized, type StoredScan } from "./api.ts";
import { h, mark } from "./dom.ts";
import { appNames, buildApp } from "./model.ts";
import { href, parse } from "./routes.ts";
import { shell } from "./shell.ts";
import { agentView } from "./views/agent.ts";
import { findingsView } from "./views/findings.ts";
import { listView } from "./views/list.ts";
import { overviewView } from "./views/overview.ts";
import { pledgeView, pledgesView } from "./views/pledges.ts";
import { scanView } from "./views/scan.ts";
import { settingsView } from "./views/settings.ts";

// ponytail: every scan is fetched whole and the pages are derived in the browser. Fine for tens of scans;
// past that, the API should serve per-app summaries instead.
const MAX_SCANS = 60;

const root = document.querySelector<HTMLElement>("#app")!;
let scans: StoredScan[] | null = null;
let apiVersion: string | null = null;

function setTheme(theme: "light" | "dark" | null): void {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  try {
    if (theme) localStorage.setItem("pledge-theme", theme);
    else localStorage.removeItem("pledge-theme");
  } catch {
    // The choice then lasts for this page only.
  }
}

function toggleTheme(): void {
  const current = document.documentElement.dataset.theme;
  const dark = current ? current === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  setTheme(dark ? "light" : "dark");
}

function signOut(): void {
  setToken(null);
  scans = null;
  void render();
}

async function load(): Promise<void> {
  const list = await listScans();
  scans = await Promise.all(list.slice(0, MAX_SCANS).map((summary) => getScan(summary.id)));
  if (apiVersion === null) {
    apiVersion = await fetch("/api/healthz").then((response) => response.json()).then((body) => (typeof body?.data?.version === "string" ? body.data.version : null), () => null);
  }
}

function gate(message: string | null): HTMLElement {
  const input = h("input", { type: "password", name: "token", placeholder: "Access token", autocomplete: "current-password", required: true, "aria-label": "Access token" });
  const error = h("p", { class: "error", role: "alert" }, message ?? "");
  const form = h(
    "form",
    {
      onsubmit: (event: Event) => {
        event.preventDefault();
        const token = input.value.trim();
        listScans(token).then(
          () => { setToken(token); void render(); },
          (reason: unknown) => { error.textContent = reason instanceof Unauthorized ? "That token was not accepted." : (reason as Error).message; },
        );
      },
    },
    input,
    h("button", { class: "btn", type: "submit" }, "Open"),
  );
  return h("div", { class: "gate-page" }, h("div", { class: "gate" }, h("p", { class: "logo" }, mark(20), "pledge"), h("p", {}, "Scans are behind an access token until sign-in is set up. Paste the token to open the dashboard on this browser."), form, error));
}

async function render(): Promise<void> {
  if (!getToken()) return root.replaceChildren(gate(null));
  try {
    if (scans === null) await load();
  } catch (reason) {
    if (reason instanceof Unauthorized) {
      setToken(null);
      return root.replaceChildren(gate("The saved token is no longer accepted. Paste the current one."));
    }
    return root.replaceChildren(h("div", { class: "gate-page" }, h("div", { class: "notice", role: "alert" }, (reason as Error).message)));
  }
  const all = scans!;
  const apps = appNames(all);
  const route = parse(location.hash);

  // The link the command line prints, "#/scans/<id>", lands on that scan inside its app.
  const legacy = route.legacyScan ? all.find((stored) => stored.id === route.legacyScan) : null;
  if (legacy) return location.replace(href(legacy.app, "scans", legacy.id));
  const app = route.app && apps.includes(route.app) ? route.app : apps[0] ?? null;
  if (app && route.app !== app) return location.replace(href(app, "overview"));

  const model = app ? buildApp(app, all) : null;
  let content: HTMLElement;
  let crumb: string | null = null;
  if (!model) {
    content = h("div", { class: "wrap" }, h("h1", {}, "No scans yet"), h("div", { class: "empty" }, h("p", {}, "Nothing has been published to this dashboard."), h("p", {}, "Run a scan and send it here with ", h("code", {}, "pledge scan <app> --scenario <name> --faults <file> --publish"), ".")));
  } else if (route.page === "settings") {
    content = settingsView({ apiVersion, onSignOut: signOut, onTheme: setTheme });
  } else if (route.page === "findings") {
    content = findingsView(model);
  } else if (route.page === "agent") {
    content = agentView(model);
  } else if (route.page === "pledges") {
    content = route.id ? pledgeView(model, route.id) : pledgesView(model);
    crumb = route.id?.split(":").pop() ?? null;
  } else if (route.page === "scans") {
    const stored = route.id ? model.scans.find((candidate) => candidate.id === route.id) : null;
    content = stored ? scanView(stored, href(model.app, "scans")) : route.id ? h("div", { class: "wrap" }, h("div", { class: "notice", role: "alert" }, "This app has no scan with that id.")) : listView(model.scans, (scan) => href(model.app, "scans", scan.id));
    crumb = stored ? `${stored.scenario}` : null;
  } else {
    content = overviewView(model);
  }

  root.replaceChildren(
    shell(
      {
        apps,
        model,
        page: route.page,
        crumb,
        onSwitchApp: (name) => { location.hash = href(name, "overview"); },
        onRefresh: () => { scans = null; void render(); },
        onToggleTheme: toggleTheme,
        onSignOut: signOut,
      },
      content,
    ),
  );
  window.scrollTo(0, 0);
}

window.addEventListener("hashchange", () => void render());
void render();
