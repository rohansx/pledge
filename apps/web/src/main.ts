import "./styles.css";

import { getScan, getToken, listScans, setToken, Unauthorized } from "./api.ts";
import { h, mark } from "./dom.ts";
import { listView } from "./views/list.ts";
import { scanView } from "./views/scan.ts";

const app = document.querySelector<HTMLElement>("#app")!;

function toggleTheme(): void {
  const root = document.documentElement;
  const dark = root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  root.dataset.theme = dark ? "light" : "dark";
  try {
    localStorage.setItem("pledge-theme", root.dataset.theme);
  } catch {
    // The choice then lasts for this page only.
  }
}

function nav(signedIn: boolean): HTMLElement {
  return h(
    "header",
    { class: "nav" },
    h(
      "div",
      { class: "nav-in" },
      h("a", { class: "logo", href: "#/", "aria-label": "Pledge, all scans" }, mark(20), "pledge"),
      signedIn ? h("nav", { class: "nav-links" }, h("a", { href: "#/", "aria-current": location.hash.startsWith("#/scans/") ? null : "page" }, "Scans")) : null,
      h(
        "div",
        { class: "nav-end" },
        h("button", { class: "icon-btn theme", type: "button", "aria-label": "Switch between light and dark", onclick: toggleTheme }, h("span", { class: "sun" }, "☀"), h("span", { class: "moon" }, "☾")),
        signedIn ? h("button", { class: "icon-btn", type: "button", onclick: () => { setToken(null); void render(); } }, "Forget token") : null,
      ),
    ),
  );
}

function show(signedIn: boolean, content: HTMLElement): void {
  app.replaceChildren(nav(signedIn), h("main", {}, content));
  window.scrollTo(0, 0);
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
  return h("div", { class: "wrap" }, h("div", { class: "gate" }, h("h1", {}, "Pledge"), h("p", {}, "Scans are behind an access token until sign-in is set up. Paste the token to open the dashboard on this browser."), form, error));
}

async function render(): Promise<void> {
  if (!getToken()) return show(false, gate(null));
  const scanId = /^#\/scans\/([^/]+)$/.exec(location.hash)?.[1];
  try {
    show(true, scanId ? scanView(await getScan(decodeURIComponent(scanId))) : listView(await listScans()));
  } catch (reason) {
    if (reason instanceof Unauthorized) {
      setToken(null);
      return show(false, gate("The saved token is no longer accepted. Paste the current one."));
    }
    show(true, h("div", { class: "wrap" }, h("a", { class: "back", href: "#/" }, "← All scans"), h("div", { class: "notice", role: "alert" }, (reason as Error).message)));
  }
}

window.addEventListener("hashchange", () => void render());
void render();
