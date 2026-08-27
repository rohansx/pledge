/**
 * `dns(name)` — done-spec-dsl.md §3.4.
 *
 * DNS is observation only. The SSRF layer blocks *connecting* to a private address, not
 * *resolving* one, so a private-range answer is reportable without pledge ever contacting it —
 * which is why this does not and must not go through @pledge/safe-fetch.
 *
 * NXDOMAIN and NODATA are observations: the name does not resolve, `resolves` is false, and
 * `a` is empty. Every other resolver failure — SERVFAIL, timeout, refused — is not an
 * observation, because it says something about the resolver rather than about the name (I-7).
 */
import { Resolver } from "node:dns/promises";
import type { Observation, ObservedValue, ObserveContext } from "./types";

/** Injected so tests never touch a real resolver. */
export interface DnsDeps {
  readonly resolve4: (name: string) => Promise<string[]>;
  readonly resolveCname: (name: string) => Promise<string[]>;
  readonly resolveTxt: (name: string) => Promise<string[][]>;
}

const NOT_FOUND = new Set(["ENOTFOUND", "ENODATA"]);
const TIMED_OUT = new Set(["ETIMEOUT", "ETIMEDOUT"]);

export function nodeDnsDeps(timeoutMs = 5000): DnsDeps {
  const resolver = new Resolver({ timeout: timeoutMs, tries: 2 });
  return {
    resolve4: (name) => resolver.resolve4(name),
    resolveCname: (name) => resolver.resolveCname(name),
    resolveTxt: (name) => resolver.resolveTxt(name),
  };
}

export async function observeDns(
  key: string,
  name: string,
  deps: DnsDeps,
  ctx: ObserveContext,
): Promise<Observation> {
  const [a, cname, txt] = await Promise.all([
    settle(deps.resolve4(name)),
    settle(deps.resolveCname(name)),
    settle(deps.resolveTxt(name)),
  ]);

  // One hard failure anywhere means we did not observe the name. The A lookup decides
  // `resolves`, so its failure is the one that must never be read as "does not resolve".
  const hard = [a, cname, txt].find((r) => r.kind === "failed");
  if (hard !== undefined && hard.kind === "failed") {
    return {
      source: key,
      observed: false,
      observedAt: ctx.now().toISOString(),
      error: { code: hard.code, message: hard.message },
      evidence: {},
    };
  }

  const addresses = a.kind === "ok" ? [...a.value].sort() : [];
  const values: Record<string, ObservedValue> = {
    a: addresses,
    // A name with no CNAME is `null`, not an error: we asked and there is not one.
    cname: cname.kind === "ok" ? (cname.value[0] ?? null) : null,
    txt: txt.kind === "ok" ? txt.value.map((chunks) => chunks.join("")).sort() : [],
    resolves: addresses.length > 0,
  };

  return {
    source: key,
    observed: true,
    observedAt: ctx.now().toISOString(),
    values,
    evidence: {},
  };
}

type Settled<T> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "absent" }
  | {
      readonly kind: "failed";
      readonly code: "dns_failure" | "timeout";
      readonly message: string;
    };

async function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  try {
    return { kind: "ok", value: await promise };
  } catch (error: unknown) {
    const code = (error as { code?: string }).code ?? "";
    if (NOT_FOUND.has(code)) return { kind: "absent" };
    return {
      kind: "failed",
      code: TIMED_OUT.has(code) ? "timeout" : "dns_failure",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
