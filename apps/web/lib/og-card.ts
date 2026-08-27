/**
 * The two OG cards, as element trees.
 *
 * product-overview.md and technical-spec.md §10 both call the card the PRIMARY ORGANIC LOOP,
 * so it is a product surface and not decoration. Which means the copy rules apply to it exactly
 * as they apply to a page:
 *
 *  · Lead with the record, not the promise (ADR-0009). The outcome is the largest thing on the
 *    card; the claim is context for it.
 *  · Never render an outcome without its criterion. security.md T-04's last mitigation is
 *    "raw spec source shown next to every outcome", and a card is the one surface that travels
 *    without a page around it — if the criterion is not ON the card, the card is the
 *    context-free green check the product exists to replace.
 *  · Say "observed", never "shipped".
 *  · An amended commitment says so. A deadline that moved and then landed on time is a
 *    different signal from one that never moved, and a card that hid the move would be the
 *    silent revision the ledger exists to prevent.
 *
 * NO JSX HERE, on purpose: `React.createElement` keeps these files plain `.ts`, so the OG code
 * is compiled identically by Next and by vitest and the tests exercise the same tree the route
 * serves. Satori accepts the element tree either way.
 *
 * Satori's flexbox subset: every element with more than one child needs an explicit `display`,
 * and there is no `gap` inheritance to lean on. Keep the styles literal.
 */
import { createElement, type ReactElement } from "react";
import type { CommitmentStatus } from "@pledge/db/types";
import type { StoredSpec } from "./spec-display";
import { describeSpec } from "./spec-display";

export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;

const COLOR = {
  bg: "#101216",
  fg: "#e8eaee",
  muted: "#9aa3b2",
  line: "#262a33",
  kept: "#4ade80",
  missed: "#f87171",
  open: "#9aa3b2",
  disputed: "#fbbf24",
} as const;

const FONT_STACK = "Geist, NotoEmoji";

/**
 * The word the card leads with, per status.
 *
 * `disputed` reads "contested" rather than "disputed" because a reader outside the product has
 * no reason to know that `disputed` is a display state and not an open ticket. `abandoned`
 * reads "withdrawn": the committer stopped, and the record says so plainly without editorial.
 */
const OUTCOME: Record<CommitmentStatus, { readonly word: string; readonly color: string }> = {
  kept: { word: "KEPT", color: COLOR.kept },
  missed: { word: "MISSED", color: COLOR.missed },
  open: { word: "OPEN", color: COLOR.open },
  disputed: { word: "CONTESTED", color: COLOR.disputed },
  abandoned: { word: "WITHDRAWN", color: COLOR.muted },
};

const h = createElement;

/** A row of small muted text. Used for the header and the footer of both cards. */
function rule(
  children: ReactElement | string,
  extra: Record<string, unknown> = {},
): ReactElement {
  return h(
    "div",
    {
      style: {
        display: "flex",
        alignItems: "center",
        fontSize: 26,
        color: COLOR.muted,
        ...extra,
      },
    },
    children,
  );
}

function shell(children: readonly ReactElement[]): ReactElement {
  return h(
    "div",
    {
      style: {
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        width: "100%",
        height: "100%",
        padding: "56px 64px",
        backgroundColor: COLOR.bg,
        color: COLOR.fg,
        fontFamily: FONT_STACK,
      },
    },
    ...children,
  );
}

/**
 * Trims to a length the card can actually fit. Satori will happily lay out a 2000-character
 * claim into an overflowing box rather than complaining, so the clamp happens here.
 */
function clamp(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1).trimEnd()}…`;
}

export interface CommitmentCardInput {
  readonly handle: string;
  readonly claim: string;
  readonly status: CommitmentStatus;
  /** Either era of stored spec — see `StoredSpec` in ./spec-display. */
  readonly spec: StoredSpec;
  /** How many times the deadline moved or the commitment was withdrawn. 0 is the usual case. */
  readonly amendmentCount: number;
}

export function commitmentCard(input: CommitmentCardInput): ReactElement {
  const outcome = OUTCOME[input.status];

  return shell([
    rule(`${clamp(input.handle, 40)} · pledge`),

    h(
      "div",
      { style: { display: "flex", flexDirection: "column" } },
      // Outcome first: the record, not the promise (ADR-0009).
      h(
        "div",
        {
          style: {
            display: "flex",
            fontSize: 88,
            lineHeight: 1,
            letterSpacing: -2,
            color: outcome.color,
          },
        },
        outcome.word,
      ),
      h(
        "div",
        { style: { display: "flex", marginTop: 20, fontSize: 44, lineHeight: 1.25 } },
        clamp(input.claim, 120),
      ),
      input.amendmentCount === 0
        ? h("div", { style: { display: "flex" } })
        : h(
            "div",
            { style: { display: "flex", marginTop: 16, fontSize: 26, color: COLOR.disputed } },
            input.amendmentCount === 1
              ? "Amended once, with a stated reason"
              : `Amended ${input.amendmentCount} times, each with a stated reason`,
          ),
    ),

    h(
      "div",
      { style: { display: "flex", flexDirection: "column" } },
      // The criterion. On the card, not one click away, because a card has no "one click".
      h(
        "div",
        {
          style: {
            display: "flex",
            padding: "16px 20px",
            border: `1px solid ${COLOR.line}`,
            borderRadius: 8,
            fontSize: 24,
            color: COLOR.fg,
          },
        },
        clamp(describeSpec(input.spec), 92),
      ),
      rule("Observed by a probe against that condition. Not self-reported.", { marginTop: 18 }),
    ),
  ]);
}

export interface ProfileCardInput {
  readonly handle: string;
  readonly total: number;
  readonly kept: number;
  readonly missed: number;
}

export function profileCard(input: ProfileCardInput): ReactElement {
  return shell([
    rule("pledge"),

    h(
      "div",
      { style: { display: "flex", flexDirection: "column" } },
      // The handle is the emoji case: a handle is arbitrary text and the card must render it
      // rather than a row of tofu (v1 exit criterion; see ./og-fonts.ts).
      h(
        "div",
        { style: { display: "flex", fontSize: 92, lineHeight: 1.1, letterSpacing: -2 } },
        clamp(input.handle, 28),
      ),
      h(
        "div",
        { style: { display: "flex", marginTop: 24, fontSize: 40 } },
        // Denominator first. A record that led with its successes would be self-reporting with
        // extra steps.
        `${input.total} ${input.total === 1 ? "commitment" : "commitments"} on the record`,
      ),
      input.total === 0
        ? h("div", { style: { display: "flex" } })
        : h(
            "div",
            { style: { display: "flex", marginTop: 14, fontSize: 40 } },
            h("span", { style: { color: COLOR.kept } }, `${input.kept} kept`),
            h("span", { style: { color: COLOR.muted, padding: "0 12px" } }, "·"),
            // Misses are shown, at the same size, in the same line.
            h("span", { style: { color: COLOR.missed } }, `${input.missed} missed`),
          ),
    ),

    rule("Every outcome resolved by a probe against a stated condition."),
  ]);
}
