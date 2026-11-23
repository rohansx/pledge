import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { scanSchema } from "./schema.ts";
import type { ScanStore } from "./store.ts";

export type Envelope<T> = { success: true; data: T; error: null } | { success: false; data: null; error: string };
export type Health = { version: string; db: "ok" };

export interface AppOptions {
  checkDb: () => Promise<void>; // rejects when the database cannot be reached
  version: string;
  store: ScanStore;
  /** The shared token every /api/scans request must carry. Undefined means the routes are closed. */
  token: string | undefined;
}

const MAX_BODY_BYTES = 1024 * 1024;

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function send<T>(res: ServerResponse, status: number, body: Envelope<T>): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function ok<T>(res: ServerResponse, status: number, data: T): void {
  send<T>(res, status, { success: true, data, error: null });
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "body too large");
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "body is not valid JSON");
  }
}

/** Constant-time comparison of the presented token with the configured one. */
function authorized(req: IncomingMessage, token: string | undefined): boolean {
  const header = req.headers.authorization ?? "";
  if (!token || !header.startsWith("Bearer ")) return false;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(header.slice("Bearer ".length)), digest(token));
}

// ponytail: three routes matched by hand. Add a router when there is a third resource.
async function route(req: IncomingMessage, res: ServerResponse, options: AppOptions): Promise<void> {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;

  if (req.method === "GET" && path === "/api/healthz") {
    try {
      await options.checkDb();
    } catch (error) {
      console.error("healthz: database check failed:", error); // detail stays in the server log
      throw new HttpError(503, "database unreachable");
    }
    return ok<Health>(res, 200, { version: options.version, db: "ok" });
  }

  if (path === "/api/scans" || path.startsWith("/api/scans/")) {
    // Sign-in through Keycloak is on hold, so until then one shared token guards every scan route.
    if (!options.token) throw new HttpError(503, "scan routes are not configured");
    if (!authorized(req, options.token)) throw new HttpError(401, "a valid token is required");

    if (path === "/api/scans" && req.method === "GET") return ok(res, 200, await options.store.list());
    if (path === "/api/scans" && req.method === "POST") {
      const parsed = scanSchema.safeParse(await readJson(req));
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new HttpError(422, `invalid scan: ${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid"}`);
      }
      return ok(res, 201, await options.store.create(parsed.data));
    }
    if (req.method === "GET") {
      const stored = await options.store.get(path.slice("/api/scans/".length));
      if (stored) return ok(res, 200, stored);
    }
  }
  throw new HttpError(404, "not found");
}

export function createApp(options: AppOptions): Server {
  return createServer((req, res) => {
    route(req, res, options).catch((error: unknown) => {
      if (error instanceof HttpError) return send(res, error.status, { success: false, data: null, error: error.message });
      console.error(`${req.method} ${req.url} failed:`, error);
      send(res, 500, { success: false, data: null, error: "internal error" });
    });
  });
}
