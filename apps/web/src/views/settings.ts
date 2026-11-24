import { h } from "../dom.ts";

export interface SettingsOptions {
  apiVersion: string | null;
  onSignOut: () => void;
  onTheme: (theme: "light" | "dark" | null) => void;
}

function block(title: string, ...children: (HTMLElement | null)[]): HTMLElement {
  return h("section", { class: "setting" }, h("h3", {}, title), h("div", {}, ...children));
}

export function settingsView(options: SettingsOptions): HTMLElement {
  const origin = location.origin;
  return h(
    "div",
    { class: "wrap narrow" },
    h("h1", {}, "Settings"),
    block(
      "Access",
      h("p", {}, "You are signed in with the shared access token, kept in this browser. There are no personal accounts yet: sign-in through Keycloak is planned and on hold, so everyone with the token sees the same thing."),
      h("p", {}, h("button", { class: "btn-line", type: "button", onclick: options.onSignOut }, "Sign out of this browser")),
    ),
    block(
      "Publishing scans",
      h("p", {}, "The dashboard shows what the command line sends it. From a machine with the token in ", h("code", {}, "PLEDGE_API_TOKEN"), ":"),
      h("pre", { class: "code texture" }, `pledge scan <app> --scenario <name> --faults <file> --seeds 5 --publish\npledge publish <app> <run-dir>...   # runs you already have`),
      h("p", { class: "mute" }, `Scans are sent to ${origin}/api/scans.`),
    ),
    block(
      "Appearance",
      h(
        "p",
        { class: "chips" },
        h("button", { class: "chip", type: "button", onclick: () => options.onTheme("light") }, "Light"),
        h("button", { class: "chip", type: "button", onclick: () => options.onTheme("dark") }, "Dark"),
        h("button", { class: "chip", type: "button", onclick: () => options.onTheme(null) }, "Match this device"),
      ),
    ),
    block(
      "Not built yet",
      h("p", {}, "Approving or retiring a pledge here, personal accounts and teams, connecting a GitHub repository, and running a scan from the dashboard. Today a pledge's status is changed in its file under ", h("code", {}, ".pledge/pledges/"), " and scans are started from the command line."),
    ),
    h("p", { class: "mute version" }, options.apiVersion ? `API version ${options.apiVersion.slice(0, 7)}` : "API version unknown"),
  );
}
