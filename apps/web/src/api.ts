import type { ScanSummary, StoredScan } from "../../api/src/schema.ts";

export type { Scan, ScanPledge, ScanRun, ScanSeed, ScanSummary, StoredScan } from "../../api/src/schema.ts";

const TOKEN_KEY = "pledge-token";

/** The API said the token is missing or wrong. The app answers by asking for one. */
export class Unauthorized extends Error {}

// The token lives in localStorage until sign-in through Keycloak replaces it. Any script on this origin could
// read it, which is why the dashboard builds every node by hand and loads no third-party script.
export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token === null) localStorage.removeItem(TOKEN_KEY);
    else localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // Private windows may refuse storage; the token then lasts until the page is reloaded.
  }
}

async function get<T>(path: string, token: string | null = getToken()): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  } catch {
    throw new Error("The Pledge API could not be reached. Check your connection and reload.");
  }
  if (response.status === 401) throw new Unauthorized();
  const body = (await response.json().catch(() => null)) as { success?: boolean; data?: T; error?: string } | null;
  if (!response.ok || !body?.success) throw new Error(body?.error ? `The API answered: ${body.error}.` : `The API answered HTTP ${response.status}.`);
  return body.data as T;
}

export const listScans = (token?: string): Promise<ScanSummary[]> => get<ScanSummary[]>("/api/scans", token);
export const getScan = (id: string): Promise<StoredScan> => get<StoredScan>(`/api/scans/${encodeURIComponent(id)}`);
