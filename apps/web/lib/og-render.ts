/**
 * One place that turns a card tree into a PNG.
 *
 * Both routes go through it so a change to the size, the font stack or the cache policy cannot
 * apply to one card and not the other — the profile card and the commitment card are the same
 * surface seen from two angles.
 *
 * CACHING. A card is fetched by crawlers, not by people, and it changes exactly when the
 * record changes: at resolution, at an amendment. A day of `s-maxage` with a week of
 * `stale-while-revalidate` means a social preview stays warm without a crawler ever waiting on
 * a cold render. The consequence to be honest about: a card can lag the page by up to a day at
 * a CDN edge. That is acceptable for a preview and would not be for the page itself.
 *
 * A missing subject renders a 404 rather than an "unknown" card. An image that says nothing is
 * worse than no image: the crawler falls back to the page's other metadata, which is true.
 */
import { ImageResponse } from "next/og";
import type { ReactElement } from "react";
import { OG_HEIGHT, OG_WIDTH } from "./og-card";
import { ogFonts } from "./og-fonts";

export async function renderOgCard(element: ReactElement): Promise<ImageResponse> {
  const fonts = await ogFonts();

  return new ImageResponse(element, {
    width: OG_WIDTH,
    height: OG_HEIGHT,
    // Replaces @vercel/og's built-in default entirely — including its emoji handling, which
    // would otherwise fetch an SVG per emoji from a CDN at render time. See ./og-fonts.ts.
    fonts: fonts.map((font) => ({ ...font })),
    headers: {
      "cache-control": "public, max-age=0, s-maxage=86400, stale-while-revalidate=604800",
    },
  });
}
