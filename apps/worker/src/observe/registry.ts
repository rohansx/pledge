/**
 * `npm(p)`, `crates(p)`, `pypi(p)` — done-spec-dsl.md §3.3.
 *
 * Three registries, one shape: fetch one JSON document from a fixed origin and read four
 * fields out of it. The differences are entirely in where each registry puts the latest
 * version and its publication time, so they are a table rather than three functions.
 *
 * A 404 is an observation here, unlike on GitHub: these are public registries with no private
 * mode, so "no such package" is a fact about the world rather than a fact about our access.
 * `latest_version` is then `null` and a `>= "1.0.0"` comparison against it is FALSE, which is
 * the honest reading of "you have not published it".
 */
import { z } from "zod";
import { callJsonApi, githubErrorCode } from "./github-api";
import type { Observation, ObservedValue, ObserveContext } from "./types";

const NPM_ORIGIN = "https://registry.npmjs.org";
const CRATES_ORIGIN = "https://crates.io/api/v1/crates";
const PYPI_ORIGIN = "https://pypi.org/pypi";

const Npm = z.object({
  "dist-tags": z.object({ latest: z.string() }).partial(),
  time: z.record(z.string(), z.string()).optional(),
  versions: z
    .record(
      z.string(),
      z
        .object({
          dist: z.object({ unpackedSize: z.number().optional() }).partial().optional(),
        })
        .loose(),
    )
    .optional(),
});

const Crates = z.object({
  crate: z.object({
    newest_version: z.string().optional(),
    max_stable_version: z.string().optional(),
    updated_at: z.string().optional(),
    downloads: z.number().optional(),
  }),
});

const Pypi = z.object({
  info: z.object({ version: z.string() }).partial(),
  releases: z
    .record(
      z.string(),
      z.array(z.object({ upload_time_iso_8601: z.string().optional() }).loose()),
    )
    .optional(),
});

export type RegistryKind = "npm" | "crates" | "pypi";

export async function observeRegistry(
  key: string,
  kind: RegistryKind,
  packageName: string,
  fetchImpl: typeof fetch,
  ctx: ObserveContext,
): Promise<Observation> {
  const url = registryUrl(kind, packageName);
  const call = await callJsonApi(url, fetchImpl);
  const observedAt = ctx.now().toISOString();

  if (call.kind === "unreachable") {
    return {
      source: key,
      observed: false,
      observedAt,
      error: { code: call.code, message: call.message },
      evidence: {},
    };
  }

  const evidence = {
    status: call.status,
    headers: call.headers,
    bodySha256: call.body.bodySha256,
    bodyBytes: call.body.bodyBytes,
    finalUrl: url,
  };

  if (call.status === 404) {
    return {
      source: key,
      observed: true,
      observedAt,
      values: { latest_version: null, published_at: null, ...emptyCounts(kind) },
      evidence,
    };
  }
  if (call.status !== 200) {
    return {
      source: key,
      observed: false,
      observedAt,
      error: {
        code: githubErrorCode(call),
        message: `${kind} registry returned ${call.status}`,
      },
      evidence: { status: call.status, headers: call.headers },
    };
  }

  const values = readValues(kind, call.json);
  if (values === undefined) {
    return {
      source: key,
      observed: false,
      observedAt,
      error: { code: "unexpected", message: `unreadable ${kind} registry payload` },
      evidence: { status: call.status, headers: call.headers },
    };
  }
  return { source: key, observed: true, observedAt, values, evidence };
}

function registryUrl(kind: RegistryKind, packageName: string): string {
  // A scoped npm name is one path segment with the slash encoded, which is why this is not
  // the split-on-slash treatment `owner/repo` gets.
  const encoded = encodeURIComponent(packageName);
  switch (kind) {
    case "npm":
      return `${NPM_ORIGIN}/${encoded}`;
    case "crates":
      return `${CRATES_ORIGIN}/${encoded}`;
    case "pypi":
      return `${PYPI_ORIGIN}/${encoded}/json`;
  }
}

/** Fields whose zero value is meaningful when the package does not exist. */
function emptyCounts(kind: RegistryKind): Record<string, ObservedValue> {
  switch (kind) {
    case "npm":
      return { version_count: 0, unpacked_size: null };
    case "crates":
      return { downloads: 0 };
    case "pypi":
      return { release_count: 0 };
  }
}

function readValues(
  kind: RegistryKind,
  json: unknown,
): Readonly<Record<string, ObservedValue>> | undefined {
  if (kind === "npm") {
    const parsed = Npm.safeParse(json);
    if (!parsed.success) return undefined;
    const latest = parsed.data["dist-tags"].latest ?? null;
    return {
      latest_version: latest,
      published_at: isoOrNull(latest === null ? undefined : parsed.data.time?.[latest]),
      version_count: Object.keys(parsed.data.versions ?? {}).length,
      unpacked_size:
        latest === null ? null : (parsed.data.versions?.[latest]?.dist?.unpackedSize ?? null),
    };
  }
  if (kind === "crates") {
    const parsed = Crates.safeParse(json);
    if (!parsed.success) return undefined;
    const c = parsed.data.crate;
    return {
      // `max_stable_version` first: a promise to publish 1.0.0 is not kept by a 1.0.0-rc.1,
      // and `newest_version` includes prereleases.
      latest_version: c.max_stable_version ?? c.newest_version ?? null,
      published_at: isoOrNull(c.updated_at),
      downloads: c.downloads ?? null,
    };
  }
  const parsed = Pypi.safeParse(json);
  if (!parsed.success) return undefined;
  const version = parsed.data.info.version ?? null;
  const files = version === null ? undefined : parsed.data.releases?.[version];
  return {
    latest_version: version,
    published_at: isoOrNull(files?.[0]?.upload_time_iso_8601),
    release_count: Object.keys(parsed.data.releases ?? {}).length,
  };
}

function isoOrNull(value: string | null | undefined): string | null {
  if (value == null) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}
