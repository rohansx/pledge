/** One line describing an /api/healthz response. `body` is untrusted: it may be anything, or missing. */
export function describeHealth(status: number, body: unknown): string {
  const data = (body as { data?: { version?: unknown; db?: unknown } } | null)?.data;
  if (status === 200 && typeof data?.version === "string" && data.db === "ok") {
    return `API ok · database ok · version ${data.version}`;
  }
  const error = (body as { error?: unknown } | null)?.error;
  return `API not healthy (HTTP ${status}${typeof error === "string" ? `: ${error}` : ""})`;
}
