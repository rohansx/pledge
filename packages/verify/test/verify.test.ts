/**
 * The conformance suite — docs/spec/receipt-format.md §8.
 *
 * These tests run against the files in ../fixtures, which are the vectors a third-party
 * implementation is measured against. If a change here needs the fixtures regenerated, the
 * format changed, and a format change is a new `format` string (§7) — not a `pnpm fixtures`
 * run to make the suite green again.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "@pledge/ledger";
import { ReceiptSchema, signedSubset } from "../src/receipt.ts";
import { formatReport } from "../src/report.ts";
import { verifyReceipt } from "../src/verify.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

const load = (name: string): unknown => JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));

const PUBLIC_KEY = readFileSync(join(FIXTURES, "fixture-key.pub"), "utf8").trim();

const VALID = ["kept.json", "missed-censored.json", "amended.json", "disputed-witness.json"] as const;

describe("valid receipts", () => {
  for (const name of VALID) {
    it(`${name} verifies steps 1 and 2`, () => {
      const result = verifyReceipt(load(name));
      expect(result.rejections).toEqual([]);
      expect(result.accepted).toBe(true);
      expect(result.steps[0]?.outcome).toBe("ok");
      expect(result.steps[1]?.outcome).toBe("ok");
    });

    it(`${name} never claims steps 3-5 passed`, () => {
      const result = verifyReceipt(load(name));
      // §4.1: report each step separately. An unanchored receipt has no inclusion proof, and
      // the difference between "not performed" and "ok" is the whole reason the rule exists.
      for (const step of result.steps.slice(2)) expect(step.outcome).toBe("not_performed");
      expect(result.anchored).toBe(false);
    });
  }

  it("reports key_trust pinned only when the caller pinned the key", () => {
    expect(verifyReceipt(load("kept.json")).keyTrust).toBe("none");
    expect(verifyReceipt(load("kept.json"), { pinnedPublicKey: PUBLIC_KEY }).keyTrust).toBe("pinned");
  });

  it("rejects a receipt signed by a key other than the pinned one", () => {
    const other = "MCowBQYDK2VwAyEAGb9ECWmEzf6FQbrBZ9w7lshQhqowtrbLDFw4rXAxZuE=";
    const result = verifyReceipt(load("kept.json"), { pinnedPublicKey: other });
    expect(result.accepted).toBe(false);
    expect(result.steps[1]?.outcome).toBe("failed");
    expect(result.keyTrust).toBe("none");
  });
});

/**
 * §2.1's pairing rule is the no-self-report invariant in wire form. The fixture is correctly
 * signed on purpose: a verifier that rejects it only because the bytes changed is not
 * enforcing the rule at all.
 */
describe("§2.1 pairing rule", () => {
  it("rejects kept + withdrawal even though the signature is valid", () => {
    const result = verifyReceipt(load("invalid-pairing.json"));
    expect(result.steps[1]?.outcome).toBe("ok");
    expect(result.accepted).toBe(false);
    expect(result.rejections.join(" ")).toContain("§2.1 pairing rule");
  });

  it("rejects every illegal pairing and accepts every legal one", () => {
    const base = ReceiptSchema.parse(load("kept.json"));
    const legal = new Set(["kept:probe", "missed:probe", "abandoned:withdrawal", "disputed:probe", "disputed:witness"]);

    for (const status of ["kept", "missed", "abandoned", "disputed"]) {
      for (const resolvedBy of ["probe", "witness", "withdrawal"]) {
        const document = structuredClone(base) as unknown as Record<string, Record<string, unknown>>;
        document.outcome = { ...base.outcome, status, resolved_by: resolvedBy };
        const paired = legal.has(`${status}:${resolvedBy}`);
        const violated = verifyReceipt(document).rejections.some((r) => r.includes("§2.1 pairing rule"));
        expect(violated, `${status} + ${resolvedBy}`).toBe(!paired);
      }
    }
  });
});

/**
 * One tampered instance per field of the signed subset (§3). Every one of them must fail —
 * the point of the signed subset is that nothing inside it can be edited after the fact.
 */
describe("tampered receipts", () => {
  const files = readdirSync(join(FIXTURES, "tampered")).sort();

  it("covers every field of the signed subset", () => {
    // A guard against the generator silently dropping a field: the count is the shape of the
    // subset, and a shrinking suite is exactly how coverage disappears unnoticed.
    expect(files.length).toBeGreaterThanOrEqual(46);
  });

  for (const file of files) {
    it(`rejects ${file}`, () => {
      const result = verifyReceipt(load(join("tampered", file)));
      expect(result.accepted).toBe(false);
      expect(result.steps[1]?.outcome).toBe("failed");
    });
  }
});

describe("fail closed (§4.1)", () => {
  const base = () => load("kept.json") as Record<string, unknown>;

  const cases: readonly (readonly [string, () => unknown])[] = [
    ["unknown format", () => ({ ...base(), format: "pledge.receipt.v2" })],
    [
      "unknown signature alg",
      () => {
        const document = base();
        return { ...document, signature: { ...(document.signature as object), alg: "ed448" } };
      },
    ],
    [
      "malformed hash",
      () => {
        const document = base();
        return { ...document, ledger: { ...(document.ledger as object), entry_hash: "sha256:not-hex" } };
      },
    ],
    [
      "unrecognised status",
      () => {
        const document = base();
        return { ...document, outcome: { ...(document.outcome as object), status: "open" } };
      },
    ],
    [
      "unknown field inside the signed subset",
      () => {
        const document = base();
        return { ...document, commitment: { ...(document.commitment as object), difficulty: "hard" } };
      },
    ],
    ["not an object", () => "just a string"],
    ["empty object", () => ({})],
  ];

  for (const [name, build] of cases) {
    it(`rejects: ${name}`, () => {
      const result = verifyReceipt(build());
      expect(result.accepted).toBe(false);
      expect(result.rejections.length).toBeGreaterThan(0);
    });
  }

  it("ignores unknown fields OUTSIDE the signed subset (§7, additive within v1)", () => {
    const result = verifyReceipt({ ...base(), some_future_field: { anything: true } });
    expect(result.accepted).toBe(true);
  });

  it("rejects a receipt that claims both an anchor and anchor_pending", () => {
    const result = verifyReceipt({ ...base(), anchor: { log: "rekor.sigstore.dev" }, anchor_pending: true });
    expect(result.accepted).toBe(false);
  });

  it("says loudly that an anchor was NOT checked rather than passing steps 3-5", () => {
    const document = { ...base(), anchor: { log: "rekor.sigstore.dev", log_index: 1 }, anchor_pending: false };
    const result = verifyReceipt(document);
    expect(result.anchored).toBe(true);
    for (const step of result.steps.slice(2)) expect(step.outcome).toBe("not_performed");
    expect(formatReport(result, "x.json")).toContain("DID NOT CHECK IT");
  });
});

/**
 * §6. A `days_actual: null` that a consumer reads as a zero biases every derived statistic in
 * pledge's favour, which is the exact bias the product exists to correct.
 */
describe("censoring (§6)", () => {
  it("rejects a receipt whose censored flag disagrees with what it is derived from", () => {
    const document = load("missed-censored.json") as Record<string, unknown>;
    const tampered = { ...document, outcome: { ...(document.outcome as object), censored: false } };
    expect(verifyReceipt(tampered).rejections.join(" ")).toContain("§6");
  });

  it("surfaces censoring in the report, in words, next to the outcome", () => {
    const report = formatReport(verifyReceipt(load("missed-censored.json")), "missed-censored.json");
    expect(report).toContain("RIGHT-CENSORED");
    expect(report).toContain("not zero");
  });
});

describe("the signed subset (§3)", () => {
  it("excludes fields the format keeps outside the signature", () => {
    const receipt = ReceiptSchema.parse(load("missed-censored.json"));
    const subset = signedSubset(receipt) as { outcome: Record<string, unknown>; ledger: Record<string, unknown> };
    expect(receipt.outcome.censored).toBe(true);
    expect(subset.outcome).not.toHaveProperty("censored");
    expect(subset.ledger).not.toHaveProperty("audit_path");
  });

  it("is unchanged by anything outside it, so a later anchor does not break a signature", () => {
    const document = load("kept.json") as Record<string, unknown>;
    const before = canonicalJson(signedSubset(ReceiptSchema.parse(document)));
    const after = canonicalJson(
      signedSubset(
        ReceiptSchema.parse({
          ...document,
          issuer: "https://someone-elses-mirror.example",
          anchor: { log: "rekor.sigstore.dev", log_index: 7 },
          anchor_pending: false,
        }),
      ),
    );
    expect(after).toBe(before);
  });

  it("rejects amendments that are not in ascending ledger_seq order", () => {
    const document = load("amended.json") as Record<string, unknown>;
    const reordered = { ...document, amendments: [...(document.amendments as unknown[])].reverse() };
    expect(verifyReceipt(reordered).rejections.join(" ")).toContain("ascending ledger_seq");
  });
});

/**
 * §4.1, first non-negotiable. This is a grep, deliberately: the guarantee is "there is no code
 * that could contact anyone", and the way to check that is to look for the code, not to observe
 * one run not doing it.
 */
describe("never contacts the issuer", () => {
  it("has no network call anywhere in the package", () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
    const offenders: string[] = [];
    for (const file of readdirSync(dir)) {
      const source = readFileSync(join(dir, file), "utf8");
      // Comments legitimately mention fetching; code must not do it.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      if (/\bfetch\s*\(|node:https?|require\(['"]https?['"]\)|undici|axios|XMLHttpRequest/.test(code)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("reads no environment variable", () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
    const offenders = readdirSync(dir).filter((file) =>
      /process\.env/.test(readFileSync(join(dir, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "")),
    );
    expect(offenders).toEqual([]);
  });
});

describe("the report (§4.3)", () => {
  it("prints the scope limit", () => {
    const report = formatReport(verifyReceipt(load("kept.json")), "kept.json");
    expect(report).toContain("it does not judge whether the done-spec was a fair test of the claim.");
  });

  it("prints the spec source next to the outcome (§1)", () => {
    const report = formatReport(verifyReceipt(load("kept.json")), "kept.json");
    expect(report).toContain('github.release("rohansx/tethr").tag matches "v0.2.*"');
  });

  it("never prints an unqualified VERIFIED", () => {
    const report = formatReport(verifyReceipt(load("kept.json")), "kept.json");
    for (const line of report.split("\n")) {
      if (line.startsWith("VERIFIED")) expect(line).toContain("steps 1-2 of 5");
    }
    expect(report).toContain("not anchored");
  });
});
