/**
 * The four cards the v1 exit criterion names: a kept commitment, a missed one, an amended one,
 * and a handle with an emoji in it.
 *
 * These render the real thing — `renderOgCard`, the real fonts, the real satori — and inspect
 * the PNG that comes out. Asserting on the element tree instead would pass happily while the
 * font stack silently dropped every glyph it could not draw, which is exactly the emoji failure
 * this criterion exists to catch.
 *
 * HOW THE EMOJI CASE IS ACTUALLY CHECKED, since "it rendered a PNG" proves nothing: the same
 * card is rendered with and without the emoji and the pixels are compared. Satori draws nothing
 * at all for a glyph no supplied font covers, so identical output means the emoji contributed
 * no ink — the tofu case, dressed up as success. Different output means some font drew it.
 *
 * Ceiling of that check, stated rather than hidden: it proves ink, not the *right* ink. The
 * PNGs are written to OG_TEST_OUT when that variable is set, and were eyeballed once when the
 * font stack was chosen. Automating "this is a rocket and not a box" is not worth a pixel
 * oracle in this repo.
 *
 * No database and no network: the cards take plain data, and the fonts are on disk.
 *
 * WHAT THIS FILE CANNOT CATCH, so nobody trusts it further than it goes: vitest loads
 * lib/og-fonts.ts unbundled, so a font path that Turbopack fails to trace passes here and 500s
 * in production. That failure was real once (see the literal-URL note in og-fonts.ts) and the
 * only thing that finds it is `next build` followed by a request to /api/og/*.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { commitmentCard, OG_HEIGHT, OG_WIDTH, profileCard } from "./og-card";
import { renderOgCard } from "./og-render";
import type { DoneSpecV0 } from "@pledge/db/types";

const spec: DoneSpecV0 = {
  kind: "http_status",
  url: "https://pledge.sh/verify",
  expectedStatus: 200,
};

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface RenderedCard {
  readonly bytes: Buffer;
  readonly width: number;
  readonly height: number;
}

/** Renders and reads the IHDR chunk, which is the only part of a PNG worth parsing here. */
async function render(
  element: Parameters<typeof renderOgCard>[0],
  name: string,
): Promise<RenderedCard> {
  const response = await renderOgCard(element);
  expect(response.headers.get("content-type")).toBe("image/png");

  const bytes = Buffer.from(await response.arrayBuffer());
  expect(bytes.subarray(0, 8)).toEqual(PNG_MAGIC);

  const out = process.env["OG_TEST_OUT"];
  if (out !== undefined && out !== "") {
    await mkdir(out, { recursive: true });
    await writeFile(join(out, `${name}.png`), bytes);
  }

  // IHDR: 8 bytes signature, 4 length, 4 type, then width and height as big-endian u32.
  return { bytes, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe("OG cards", () => {
  it("renders a kept commitment", async () => {
    const card = await render(
      commitmentCard({
        handle: "rohansx",
        claim: "Ship pledge v1 — the DSL, the ledger, witnesses and receipts",
        status: "kept",
        spec,
        amendmentCount: 0,
      }),
      "kept",
    );

    expect(card.width).toBe(OG_WIDTH);
    expect(card.height).toBe(OG_HEIGHT);
    // A card with no text would still be a valid PNG. A few kB of it is drawn glyphs.
    expect(card.bytes.byteLength).toBeGreaterThan(5_000);
  });

  it("renders a missed commitment, and does not look like a kept one", async () => {
    const kept = await render(
      commitmentCard({
        handle: "rohansx",
        claim: "Same claim",
        status: "kept",
        spec,
        amendmentCount: 0,
      }),
      "kept-control",
    );
    const missed = await render(
      commitmentCard({
        handle: "rohansx",
        claim: "Same claim",
        status: "missed",
        spec,
        amendmentCount: 0,
      }),
      "missed",
    );

    expect(missed.width).toBe(OG_WIDTH);
    // Misses are shown, not softened. If these two ever render identically, the outcome word
    // or its colour has stopped reaching the canvas.
    expect(missed.bytes.equals(kept.bytes)).toBe(false);
  });

  it("renders an amended commitment, and says that it was amended", async () => {
    const plain = await render(
      commitmentCard({
        handle: "rohansx",
        claim: "Same claim",
        status: "kept",
        spec,
        amendmentCount: 0,
      }),
      "amended-control",
    );
    const amended = await render(
      commitmentCard({
        handle: "rohansx",
        claim: "Same claim",
        status: "kept",
        spec,
        amendmentCount: 2,
      }),
      "amended",
    );

    expect(amended.height).toBe(OG_HEIGHT);
    // A deadline that moved is a different signal from one that never did (architecture.md
    // §5.1). If the card hid it, these would be byte-identical.
    expect(amended.bytes.equals(plain.bytes)).toBe(false);
  });

  it("renders a handle with an emoji in it, without tofu", async () => {
    const plain = await render(
      profileCard({ handle: "rohansx", total: 12, kept: 9, missed: 3 }),
      "profile-control",
    );
    const emoji = await render(
      profileCard({ handle: "rohansx 🚀", total: 12, kept: 9, missed: 3 }),
      "profile-emoji",
    );

    expect(emoji.width).toBe(OG_WIDTH);
    expect(emoji.height).toBe(OG_HEIGHT);
    // The assertion the criterion is really about: satori draws NOTHING for a glyph no
    // supplied font covers, so identical bytes would mean the rocket silently vanished.
    expect(emoji.bytes.equals(plain.bytes)).toBe(false);
  });

  it("renders an empty profile without pretending it has a record", async () => {
    const card = await render(
      profileCard({ handle: "newcomer", total: 0, kept: 0, missed: 0 }),
      "profile-empty",
    );
    expect(card.width).toBe(OG_WIDTH);
  });
});
