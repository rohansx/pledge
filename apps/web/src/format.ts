// Pure helpers for turning scan data into words and rows. No DOM here, so they are tested with node --test.

const MATCHERS = ["eq", "gte", "lte", "len", "exists"];

/** An engine matcher such as {"lte": 1}; any other expected value means "equals". */
function asMatcher(expected: unknown): [string, unknown] {
  if (expected !== null && typeof expected === "object" && !Array.isArray(expected)) {
    const keys = Object.keys(expected);
    if (keys.length === 1 && MATCHERS.includes(keys[0]!)) return [keys[0]!, (expected as Record<string, unknown>)[keys[0]!]];
  }
  return ["eq", expected];
}

/** Whether an observed value satisfies what was expected, by the engine's matcher rules. */
export function satisfies(expected: unknown, actual: unknown): boolean {
  const [op, operand] = asMatcher(expected);
  if (op === "exists") return operand === (actual !== null && actual !== undefined);
  if (op === "gte") return typeof actual === "number" && typeof operand === "number" && actual >= operand;
  if (op === "lte") return typeof actual === "number" && typeof operand === "number" && actual <= operand;
  if (op === "len") return (typeof actual === "string" || Array.isArray(actual)) && actual.length === operand;
  return JSON.stringify(actual) === JSON.stringify(operand);
}

/** A value as a person reads it: matchers as symbols, strings bare, everything else compact JSON. */
export function show(value: unknown): string {
  if (value === undefined) return "";
  const [op, operand] = asMatcher(value);
  const symbol: Record<string, string> = { gte: "at least ", lte: "at most ", len: "length " };
  if (op === "exists") return operand ? "present" : "absent";
  if (op !== "eq") return `${symbol[op]}${show(operand)}`;
  return typeof value === "string" ? value : JSON.stringify(value);
}

export interface CheckRow {
  key: string;
  expected: string;
  actual: string;
  differs: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Expected against actual, one row per checked field when both are objects keyed the same way, else one row. */
export function checkRows(expected: unknown, actual: unknown): CheckRow[] {
  if (isRecord(expected) && isRecord(actual) && Object.keys(expected).length > 0 && asMatcher(expected)[0] === "eq") {
    return Object.keys(expected).map((key) => ({
      key: key.replace(/^\//, ""),
      expected: show(expected[key]),
      actual: key in actual ? show(actual[key]) : "missing",
      differs: !(key in actual) || !satisfies(expected[key], actual[key]),
    }));
  }
  return [{ key: "", expected: show(expected), actual: show(actual), differs: !satisfies(expected, actual) }];
}

/** "2 of 8 pledges broken", "all 8 pledges kept", and so on. */
export function pledgeCount(total: number, broken: number): string {
  if (total === 0) return "no pledges";
  const noun = total === 1 ? "pledge" : "pledges";
  if (broken === 0) return `no ${noun} broken`;
  return `${broken} of ${total} ${noun} broken`;
}

export function seedsCount(verdicts: string[]): string {
  const failed = verdicts.filter((verdict) => verdict === "fail").length;
  const noun = verdicts.length === 1 ? "seed" : "seeds";
  return failed === 0 ? `${verdicts.length} ${noun}, none failed` : `failed on ${failed} of ${verdicts.length} ${noun}`;
}

/** One sentence for the top of a scan: what the verdict means here. */
export function verdictSentence(verdict: string, total: number, broken: number, approved: number): string {
  if (verdict === "broken") return `${pledgeCount(total, broken)}, at least one of them approved. This would block a merge.`;
  if (verdict === "kept") return `Every approved pledge held on every seed.`;
  if (broken > 0 && approved === 0) return `${pledgeCount(total, broken)}, but none is approved yet, so nothing blocks. Review the broken ones.`;
  if (approved === 0) return `No pledge is approved yet, so there is nothing to block on.`;
  return `At least one approved pledge could not be judged on every seed.`;
}

export function when(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  const minutes = Math.round((now.getTime() - then.getTime()) / 60_000);
  if (Number.isNaN(minutes)) return "";
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)} h ago`;
  return then.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** A model's summary arrives as light markdown. Show it as plain text: drop the emphasis and code marks. */
export function plain(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/g, "$1").replace(/`([^`\n]+)`/g, "$1");
}

export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export function seconds(value: number): string {
  return value >= 60 ? `${Math.floor(value / 60)} min ${Math.round(value % 60)} s` : `${Math.round(value * 10) / 10} s`;
}

export function thousands(value: number): string {
  return value.toLocaleString("en-US");
}
