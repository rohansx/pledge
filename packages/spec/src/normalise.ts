/**
 * Canonicalisation step 2 and step 3 (done-spec-dsl.md §5) — source and literal normalisation.
 *
 * These run at parse time rather than in a later pass so that a rejection can point at the
 * token that caused it. The result is idempotent by construction: re-normalising a
 * normalised value returns the same string, which is what makes `canonicalise` a fixed
 * point and the round-trip property testable.
 *
 * Every rule that looks like tidiness is a control. Rejecting `.` and `..` in a repo or a
 * path is not aesthetics: these segments are interpolated into api.github.com paths by the
 * worker, `encodeURIComponent` leaves dots alone, and the WHATWG URL parser then collapses
 * `/repos/../..` to `/` — which answers 200 and would be read as an observation of a target
 * that was never observed. That is an I-7 violation reached through a naming rule.
 */

export class NormaliseError extends Error {}

const fail = (message: string): never => {
  throw new NormaliseError(message);
};

// Matching C0/C1 controls is the point. (No eslint-disable needed — the escapes below are
// literal `\uXXXX`, which no-control-regex does not flag.)
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

/** §5 step 3: strings are NFC-normalised. Control characters never survive into an AST. */
export function normaliseString(value: string, what = "string"): string {
  if (CONTROL_CHARS.test(value)) fail(`control character in ${what}`);
  return value.normalize("NFC");
}

/**
 * §5 step 2. `new URL` already lowercases the scheme and host, drops the default port and
 * preserves query order; the remaining work is the rejections and the empty-path rule.
 */
export function normaliseUrl(raw: string): string {
  if (raw.includes("#")) fail("URL must not contain a fragment");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail(`not a valid URL: ${raw}`);
  }
  // §3.1: https only. `http://` is admitted by the grammar only for `.onion`, which the SSRF
  // layer rejects anyway, so the language is https-only in practice — say so here.
  if (url.protocol !== "https:") fail(`URL scheme must be https, got ${url.protocol.replace(":", "")}`);
  if (url.username !== "" || url.password !== "") fail("URL must not contain credentials");
  if (url.hostname === "") fail("URL must have a host");
  const path = url.pathname === "/" ? "" : url.pathname;
  return `${url.protocol}//${url.host}${path}${url.search}`;
}

const REPO_SEGMENT = /^[A-Za-z0-9._-]{1,100}$/;

/** §5 step 2: `owner/repo`, lowercased. */
export function normaliseRepo(raw: string): string {
  const segments = raw.split("/");
  if (segments.length !== 2) fail(`repo must be in owner/name form, got ${raw}`);
  for (const segment of segments) {
    if (!REPO_SEGMENT.test(segment)) fail(`invalid repo segment "${segment}"`);
    if (/^\.+$/.test(segment)) fail("repo segments must not be . or ..");
  }
  return raw.toLowerCase();
}

/**
 * npm, crates.io and PyPI all treat names case-insensitively, so two specs that name the
 * same package must not differ in hash over capitalisation. One rule covers all three; the
 * optional scope prefix is only meaningful to npm and is harmless elsewhere.
 */
const PACKAGE_NAME = /^(@[a-z0-9][a-z0-9._~-]{0,99}\/)?[a-z0-9][a-z0-9._~-]{0,213}$/;

export function normalisePackage(raw: string): string {
  const lowered = raw.toLowerCase();
  if (!PACKAGE_NAME.test(lowered)) fail(`invalid package name "${raw}"`);
  return lowered;
}

/**
 * A free-form string argument: a branch name, a GitHub login, a workflow file.
 *
 * These are charset-restricted because they are the only strings that reach a `targetKey`
 * (keys.ts) in a position where a modifier segment can follow. Modifier segments are built by
 * bare concatenation — `+name=value`, no escaping — and the key shape is pinned by §6.2, which
 * wants the key to read back as the accessor a human authored rather than as an escaped blob.
 * So the separators are kept out of the values instead:
 *
 *     github.commits("o/r").by("alice").on_branch("main")
 *     github.commits("o/r").by("alice+on_branch=main")
 *
 * are two specs with two different hashes and would otherwise share ONE targetKey — which means
 * two leaves inside one spec judged on each other's evidence. A branch name, a login and a
 * workflow file all have well-defined legal characters, and `+ = , :` are not among them.
 */
const KEY_SAFE = /^[A-Za-z0-9._\- /]{1,200}$/;

export function normaliseKeyArgument(raw: string, what = "value"): string {
  const value = normaliseString(raw, what);
  if (!KEY_SAFE.test(value)) {
    fail(`${what} may contain only letters, digits, space and . _ - / — got "${raw}"`);
  }
  return value;
}

const DNS_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export function normaliseHostname(raw: string): string {
  const lowered = raw.toLowerCase().replace(/\.$/, "");
  if (lowered.length === 0 || lowered.length > 253) fail(`invalid hostname "${raw}"`);
  const labels = lowered.split(".");
  for (const label of labels) {
    if (!DNS_LABEL.test(label)) fail(`invalid hostname label "${label}"`);
  }
  return lowered;
}

/**
 * A repository-relative path. Case is preserved — git paths are case-sensitive, and
 * lowercasing one would change which file was promised.
 */
export function normalisePath(raw: string): string {
  const value = normaliseString(raw, "path");
  if (value.length === 0 || value.length > 400) fail("path must be 1-400 characters");
  if (value.startsWith("/")) fail("path must be repository-relative, without a leading /");
  if (value.includes("\\")) fail("path must not contain a backslash");
  const segments = value.split("/");
  for (const segment of segments) {
    if (segment === "") fail("path must not contain an empty segment");
    if (/^\.+$/.test(segment)) fail("path segments must not be . or ..");
  }
  return value;
}

/** RFC 6901. The empty pointer (whole document) is legal. */
export function normaliseJsonPointer(raw: string): string {
  const value = normaliseString(raw, "JSON pointer");
  if (value !== "" && !/^(\/([^/~]|~[01])*)+$/.test(value)) {
    fail(`not a valid RFC 6901 JSON pointer: "${raw}"`);
  }
  return value;
}

/** Decodes the JSON escapes the grammar admits. The surrounding quotes are still attached. */
export function decodeStringLiteral(image: string): string {
  const body = image.slice(1, -1);
  let out = "";
  let i = 0;
  while (i < body.length) {
    const ch = body[i] as string;
    if (ch !== "\\") {
      out += ch;
      i += 1;
      continue;
    }
    const esc = body[i + 1];
    switch (esc) {
      case '"':
        out += '"';
        break;
      case "\\":
        out += "\\";
        break;
      case "/":
        out += "/";
        break;
      case "b":
        out += "\b";
        break;
      case "f":
        out += "\f";
        break;
      case "n":
        out += "\n";
        break;
      case "r":
        out += "\r";
        break;
      case "t":
        out += "\t";
        break;
      case "u": {
        const hex = body.slice(i + 2, i + 6);
        out += String.fromCharCode(Number.parseInt(hex, 16));
        i += 6;
        continue;
      }
      default:
        return fail(`invalid escape sequence \\${esc ?? ""} in string literal`);
    }
    i += 2;
  }
  // A `\n` written as an escape is still a control character in the value. §5 step 3 has no
  // representation for one, and a spec whose rendered source does not match its meaning is
  // exactly what this product exists not to produce.
  if (CONTROL_CHARS.test(out)) fail("control character in string literal");
  if (!isWellFormed(out)) fail("lone surrogate in string literal");
  return out.normalize("NFC");
}

/**
 * RFC 8785 has no encoding for a lone surrogate, so one must not reach the serialiser.
 * `String.prototype.isWellFormed` is ES2024; the regex is the fallback for older runtimes,
 * since this package ships to whatever browser the composer runs in.
 */
export function isWellFormed(value: string): boolean {
  const native = (value as { isWellFormed?: () => boolean }).isWellFormed;
  if (typeof native === "function") return native.call(value);
  return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value);
}
