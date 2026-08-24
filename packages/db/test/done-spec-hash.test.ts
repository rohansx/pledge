/**
 * `done_spec.hash` is the contract (CLAUDE.md I-4). Two properties have to hold or it is not
 * one: the same spec always hashes the same, and two different specs never share a hash.
 */
import { describe, expect, it } from "vitest";
import { canonicalDoneSpecJson, hashDoneSpec } from "../src/done-spec-hash";
import type { DoneSpecV0 } from "../src/types";

describe("hashDoneSpec", () => {
  it("is insensitive to key order — the same spec is the same commitment", () => {
    const a = hashDoneSpec({ kind: "http_status", url: "https://x.test", expectedStatus: 200 });
    const b = hashDoneSpec({ expectedStatus: 200, url: "https://x.test", kind: "http_status" });
    expect(a.hash).toBe(b.hash);
  });

  it("is stable across calls", () => {
    const spec: DoneSpecV0 = {
      kind: "github_release_tag",
      repo: "rohansx/tethr",
      tagPattern: "v0.2.*",
    };
    expect(hashDoneSpec(spec).hash).toBe(hashDoneSpec(spec).hash);
  });

  it("separates specs that differ in any field", () => {
    const base = { kind: "http_status", url: "https://x.test", expectedStatus: 200 } as const;
    const hashes = new Set([
      hashDoneSpec(base).hash,
      hashDoneSpec({ ...base, expectedStatus: 201 }).hash,
      hashDoneSpec({ ...base, url: "https://y.test" }).hash,
      hashDoneSpec({ kind: "github_release_tag", repo: "a/b", tagPattern: "v1.*" }).hash,
      hashDoneSpec({ kind: "github_release_tag", repo: "a/b", tagPattern: "v2.*" }).hash,
    ]);
    expect(hashes.size).toBe(5);
  });

  it("produces lowercase hex sha256, which is what the column CHECK accepts", () => {
    expect(
      hashDoneSpec({ kind: "http_status", url: "https://x.test", expectedStatus: 200 }).hash,
    ).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses to content-address an invalid spec", () => {
    // Validation is not decoration: hashing an unvalidated shape would give a stable hash to
    // something that can never be evaluated.
    expect(() =>
      hashDoneSpec({ kind: "http_status", url: "http://x.test", expectedStatus: 200 }),
    ).toThrow();
    expect(() => hashDoneSpec({ kind: "nope" })).toThrow();
  });

  it("refuses a repo whose segments are dot-segments — an I-7 control, not tidiness", () => {
    // `/repos/../../releases/latest` collapses to `/releases/latest`, and the 404
    // disambiguation request collapses to `/`, which answers 200. The probe would read that
    // as "repo visible, no release" and record `fail` for a target it never observed.
    for (const repo of ["../..", "./x", "x/..", ".."]) {
      expect(() =>
        hashDoneSpec({ kind: "github_release_tag", repo, tagPattern: "v*" }),
      ).toThrow();
    }
    // Dot-prefixed names are ordinary GitHub repositories and stay valid.
    expect(() =>
      hashDoneSpec({ kind: "github_release_tag", repo: "rohansx/.github", tagPattern: "v*" }),
    ).not.toThrow();
  });

  it("canonicalises to sorted-key JSON with no whitespace", () => {
    expect(
      canonicalDoneSpecJson({
        kind: "http_status",
        url: "https://x.test",
        expectedStatus: 200,
      }),
    ).toBe('{"expectedStatus":200,"kind":"http_status","url":"https://x.test"}');
  });
});
