export const PAGES = ["overview", "findings", "pledges", "scans", "agent", "settings"] as const;
export type Page = (typeof PAGES)[number];

export interface Route {
  app: string | null;
  page: Page;
  id: string | null;
  legacyScan: string | null; // "#/scans/<id>", the link `pledge scan --publish` prints
}

export function href(app: string, page: Page, id?: string): string {
  return `#/a/${encodeURIComponent(app)}/${page}${id ? `/${encodeURIComponent(id)}` : ""}`;
}

export function parse(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] === "scans" && parts[1]) return { app: null, page: "scans", id: null, legacyScan: parts[1] };
  if (parts[0] === "a" && parts[1]) {
    const page = (PAGES as readonly string[]).includes(parts[2] ?? "") ? (parts[2] as Page) : "overview";
    return { app: parts[1], page, id: parts[3] ?? null, legacyScan: null };
  }
  return { app: null, page: "overview", id: null, legacyScan: null };
}
