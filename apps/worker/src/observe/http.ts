/**
 * `http(url)` — done-spec-dsl.md §3.1.
 *
 * The URL is user-supplied and therefore hostile (architecture.md §4, zone 0), so it goes
 * through @pledge/safe-fetch and nothing else — no bare fetch, no axios, no raw undici
 * (CLAUDE.md I-5). A second HTTP path around safe-fetch is how the SSRF defence dies.
 *
 * One request produces every field the spec reads off this source: `.status`, `.text`,
 * `.text.length`, `.final_url`, any `.header(name)` and any `.json(pointer)`. That is the
 * memoisation the technical spec asks for, and it lives here rather than in the caller
 * because only this function knows that all six come out of the same response.
 */
import { SafeFetchError, type SafeFetch, type SafeFetchResponse } from "@pledge/safe-fetch";
import { EVIDENCE_HEADER_ALLOWLIST } from "@pledge/db/types";
import { fieldKey } from "./keys";
import type { FieldRead, Observation, ObservedValue } from "./types";

export async function observeHttp(
  key: string,
  url: string,
  fields: readonly FieldRead[],
  safeFetch: SafeFetch,
  now: () => Date,
): Promise<Observation> {
  let response: SafeFetchResponse;
  try {
    response = await safeFetch(url, { method: "GET" });
  } catch (error: unknown) {
    // Everything safe-fetch throws means "we did not see the target": a blocked address, a
    // timeout, a refused connection, a body over the cap. None of them say anything about
    // whether the done-condition holds, so none of them may become an observed value.
    return {
      source: key,
      observed: false,
      observedAt: now().toISOString(),
      error: {
        code: error instanceof SafeFetchError ? error.code : "unexpected",
        message: error instanceof Error ? error.message : String(error),
      },
      evidence:
        error instanceof SafeFetchError && error.resolvedIp !== undefined
          ? { resolvedIp: error.resolvedIp }
          : {},
    };
  }

  // `text` is decoded once and shared. Decoding is lossy for non-UTF-8 targets — U+FFFD for
  // undecodable bytes — which is why `.text.length` is the BYTE length off the wire and not
  // this string's length (§3.1). A `contains` against a mojibake page is a `fail`, which is
  // an honest observation of a page we did read.
  const text = new TextDecoder("utf-8").decode(response.body);
  const values: Record<string, ObservedValue> = {
    status: response.status,
    text,
    "text.length": response.bodyBytes,
    final_url: response.finalUrl,
  };

  for (const field of fields) {
    if (field.path[0] === "header" && field.arg !== undefined) {
      const name = field.arg.toLowerCase();
      // §6.2: only whitelisted headers are readable, and therefore only they are stored.
      // Reading outside the list yields no key at all rather than `null`, so the evaluator
      // reports it as unreadable instead of comparing against an absence we invented.
      if ((EVIDENCE_HEADER_ALLOWLIST as readonly string[]).includes(name)) {
        values[fieldKey(field)] = response.headers[name] ?? null;
      }
    } else if (field.path[0] === "json" && field.arg !== undefined) {
      const pointer = jsonPointer(text, field.arg);
      if (pointer.ok) values[fieldKey(field)] = pointer.value;
    }
  }

  return {
    source: key,
    observed: true,
    observedAt: now().toISOString(),
    values,
    evidence: {
      status: response.status,
      headers: pickHeaders(response.headers),
      bodySha256: response.bodySha256,
      bodyBytes: response.bodyBytes,
      resolvedIp: response.resolvedIp,
      finalUrl: response.finalUrl,
    },
  };
}

function pickHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const name of EVIDENCE_HEADER_ALLOWLIST) {
    const value = headers[name];
    if (value !== undefined) kept[name] = value;
  }
  return kept;
}

/**
 * RFC 6901 resolution against the response body.
 *
 * A body that is not JSON, or a pointer that does not resolve, produces no key — the field is
 * unreadable, which the evaluator reports as an error. It is emphatically not `null`: "the
 * server sent HTML" and "the server sent `{"deployed": null}`" are different observations and
 * flattening them would let a 500 error page satisfy `.json("/x") != "y"`.
 */
function jsonPointer(
  text: string,
  pointer: string,
): { ok: true; value: unknown } | { ok: false } {
  let document: unknown;
  try {
    document = JSON.parse(text) as unknown;
  } catch {
    return { ok: false };
  }
  if (pointer === "") return { ok: true, value: document };

  let current: unknown = document;
  for (const rawSegment of pointer.slice(1).split("/")) {
    const segment = rawSegment.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length)
        return { ok: false };
      current = current[index];
      continue;
    }
    if (current === null || typeof current !== "object") return { ok: false };
    const record = current as Record<string, unknown>;
    if (!Object.hasOwn(record, segment)) return { ok: false };
    current = record[segment];
  }
  return { ok: true, value: current };
}
