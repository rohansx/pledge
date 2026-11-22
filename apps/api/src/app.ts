import { createServer, type Server, type ServerResponse } from "node:http";

export type Envelope<T> = { success: true; data: T; error: null } | { success: false; data: null; error: string };
export type Health = { version: string; db: "ok" };

function send<T>(res: ServerResponse, status: number, body: Envelope<T>): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

/** The HTTP API. `checkDb` rejects when the database cannot be reached. */
// ponytail: one route, so no router. Add one when there is a second resource.
export function createApp(checkDb: () => Promise<void>, version: string): Server {
  return createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/api/healthz") {
      try {
        await checkDb();
        send<Health>(res, 200, { success: true, data: { version, db: "ok" }, error: null });
      } catch (error) {
        console.error("healthz: database check failed:", error); // detail stays in the server log
        send(res, 503, { success: false, data: null, error: "database unreachable" });
      }
      return;
    }
    send(res, 404, { success: false, data: null, error: "not found" });
  });
}
