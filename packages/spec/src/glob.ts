/**
 * `matches` is glob, not regex (done-spec-dsl.md §4.3).
 *
 * The input to a match is a remote page body. A regex over attacker-influenced input is a
 * ReDoS primitive, and a regex in a spec is write-only for the person the record is meant to
 * convince. Neither trade is worth making, so the language has globs and only globs:
 * `*`, `?`, `[abc]`, `[a-z]`, `{alt1,alt2}`.
 *
 * Cost is bounded twice over. Alternations are expanded at COMPILE time under a hard cap, so
 * a pattern like `{a,b}{a,b}{a,b}…` is rejected when the spec is authored rather than
 * exploding when it is probed. Each expanded alternative is then matched by the two-pointer
 * greedy algorithm: O(pattern × subject) worst case, no backtracking blowup, no recursion.
 *
 * There is no escape character. A pattern cannot match a literal `*`, and that is the whole
 * of the limitation — adding `\` escapes is a spec_version 2 change, not a patch to v1.
 */

/** A generous ceiling: every real template pattern expands to one or two alternatives. */
const MAX_ALTERNATIVES = 64;
const MAX_PATTERN_LENGTH = 500;

type Piece =
  | { readonly t: "lit"; readonly ch: string }
  | { readonly t: "any" } // ?
  | { readonly t: "star" } // *
  | { readonly t: "class"; readonly ranges: readonly (readonly [string, string])[] };

export type CompiledGlob = { readonly source: string; readonly alternatives: readonly Piece[][] };

export class GlobError extends Error {}

/**
 * Expands `{a,b}` groups into a flat list of brace-free patterns. Nested braces are handled
 * by recursion on the remainder, which is why the cap is checked on every append.
 */
function expandBraces(pattern: string): string[] {
  let out: string[] = [""];
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i] as string;
    if (ch === "{") {
      const close = findClosingBrace(pattern, i);
      if (close === -1) throw new GlobError("unbalanced { in glob pattern");
      const alts = splitTopLevel(pattern.slice(i + 1, close));
      if (alts.length === 0) throw new GlobError("empty {} group in glob pattern");
      const expandedAlts = alts.flatMap((alt) => expandBraces(alt));
      const next: string[] = [];
      for (const prefix of out) {
        for (const alt of expandedAlts) {
          next.push(prefix + alt);
          if (next.length > MAX_ALTERNATIVES) {
            throw new GlobError(`glob pattern expands to more than ${MAX_ALTERNATIVES} alternatives`);
          }
        }
      }
      out = next;
      i = close + 1;
      continue;
    }
    if (ch === "[") {
      const close = pattern.indexOf("]", i + 1);
      if (close === -1) throw new GlobError("unbalanced [ in glob pattern");
      const chunk = pattern.slice(i, close + 1);
      out = out.map((prefix) => prefix + chunk);
      i = close + 1;
      continue;
    }
    if (ch === "}") throw new GlobError("unbalanced } in glob pattern");
    out = out.map((prefix) => prefix + ch);
    i += 1;
  }
  return out;
}

function findClosingBrace(pattern: string, open: number): number {
  let depth = 0;
  for (let i = open; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === "[") {
      const close = pattern.indexOf("]", i + 1);
      if (close === -1) return -1;
      i = close;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Splits on commas that are not inside a nested brace group or a character class. */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === "[") {
      const close = body.indexOf("]", i + 1);
      if (close === -1) throw new GlobError("unbalanced [ in glob pattern");
      i = close;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
    else if (ch === "," && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  return parts;
}

function compileAlternative(pattern: string): Piece[] {
  const pieces: Piece[] = [];
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i] as string;
    if (ch === "*") {
      // Collapse `**` — two stars are the same language as one, and collapsing keeps the
      // matcher's single-star-pointer invariant honest.
      if (pieces[pieces.length - 1]?.t !== "star") pieces.push({ t: "star" });
      i += 1;
    } else if (ch === "?") {
      pieces.push({ t: "any" });
      i += 1;
    } else if (ch === "[") {
      const close = pattern.indexOf("]", i + 1);
      if (close === -1) throw new GlobError("unbalanced [ in glob pattern");
      const body = pattern.slice(i + 1, close);
      if (body.length === 0) throw new GlobError("empty [] class in glob pattern");
      pieces.push({ t: "class", ranges: parseClass(body) });
      i = close + 1;
    } else {
      pieces.push({ t: "lit", ch });
      i += 1;
    }
  }
  return pieces;
}

function parseClass(body: string): (readonly [string, string])[] {
  const ranges: (readonly [string, string])[] = [];
  const chars = [...body];
  let i = 0;
  while (i < chars.length) {
    const from = chars[i] as string;
    const dash = chars[i + 1];
    const to = chars[i + 2];
    if (dash === "-" && to !== undefined) {
      if (to < from) throw new GlobError(`reversed range [${from}-${to}] in glob pattern`);
      ranges.push([from, to]);
      i += 3;
    } else {
      ranges.push([from, from]);
      i += 1;
    }
  }
  return ranges;
}

export function compileGlob(pattern: string): CompiledGlob {
  if (pattern.length > MAX_PATTERN_LENGTH) {
    throw new GlobError(`glob pattern longer than ${MAX_PATTERN_LENGTH} characters`);
  }
  const alternatives = expandBraces(pattern).map(compileAlternative);
  return { source: pattern, alternatives };
}

/**
 * Two-pointer greedy match with one remembered star position. Whole-string match, anchored
 * at both ends — `contains` is a separate operator and this one does not silently behave
 * like it.
 *
 * Iterates code points, not UTF-16 units, so `?` matches one character and never half of a
 * surrogate pair.
 */
function matchAlternative(pieces: readonly Piece[], subject: readonly string[]): boolean {
  let s = 0;
  let p = 0;
  let starP = -1;
  let starS = 0;
  while (s < subject.length) {
    const piece = pieces[p];
    if (piece && pieceMatches(piece, subject[s] as string)) {
      s += 1;
      p += 1;
    } else if (piece?.t === "star") {
      starP = p;
      starS = s;
      p += 1;
    } else if (starP !== -1) {
      starS += 1;
      s = starS;
      p = starP + 1;
    } else {
      return false;
    }
  }
  while (pieces[p]?.t === "star") p += 1;
  return p === pieces.length;
}

function pieceMatches(piece: Piece, ch: string): boolean {
  switch (piece.t) {
    case "lit":
      return piece.ch === ch;
    case "any":
      return true;
    case "class":
      return piece.ranges.some(([from, to]) => ch >= from && ch <= to);
    case "star":
      return false; // handled by the caller's star bookkeeping
  }
}

export function globMatches(glob: CompiledGlob, subject: string): boolean {
  const chars = [...subject];
  return glob.alternatives.some((pieces) => matchAlternative(pieces, chars));
}
