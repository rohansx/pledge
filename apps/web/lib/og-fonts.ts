/**
 * Fonts for the OG cards.
 *
 * WHY THIS FILE EXISTS AT ALL: satori has no default font of its own and no fallback chain
 * from the operating system. Passing a `fonts` array replaces `@vercel/og`'s built-in default
 * outright, so the moment we supply one font we owe it every glyph the card can contain — and
 * a glyph with no font renders as nothing. A handle with an emoji in it is a v1 exit criterion
 * precisely because that is where an unbundled font stack fails silently and visibly.
 *
 * WHY NOT the `emoji: 'twemoji'` option `@vercel/og` offers: it fetches an SVG per emoji from
 * jsdelivr at render time. That makes the product's primary organic loop (technical-spec §10)
 * depend on a third-party CDN being up during a social crawler's fetch, and it makes the OG
 * tests require network. A bundled font renders the same picture with neither.
 *
 * The emoji face is Noto Emoji — the MONOCHROME one, outlines rather than the colour bitmaps
 * in NotoColorEmoji. Satori rasterises glyph outlines; a CBDT/CBLC bitmap font parses fine and
 * draws nothing, which is the failure this comment exists to stop someone re-introducing.
 * Monochrome also happens to suit a card that is otherwise two colours.
 *
 * Provenance and licences live next to the files in ../assets/og:
 *   Geist-Regular.ttf         — SIL OFL, vendored from @vercel/og's own default font
 *   NotoEmoji-Regular.woff    — SIL OFL, @fontsource/noto-emoji (emoji subset)
 */
import { readFile } from "node:fs/promises";

export interface OgFont {
  readonly name: string;
  readonly data: ArrayBuffer;
  readonly weight: 400;
  readonly style: "normal";
}

/**
 * Read once per process. Both faces together are under a megabyte, and an OG card is served to
 * crawlers in bursts — re-reading from disk per request would be the one avoidable cost in an
 * otherwise CPU-bound render.
 */
let cached: Promise<readonly OgFont[]> | undefined;

/**
 * `new URL(<literal>, import.meta.url)` rather than a cwd-relative path: the route that calls
 * this is bundled, and cwd differs between `next dev` from apps/web, a vitest run from the repo
 * root, and a deployed server.
 *
 * THE LITERAL IS LOAD-BEARING. Turbopack recognises this exact shape and copies the file into
 * the build output; a template with a variable in it is not statically analysable, resolves to
 * some unrelated chunk at runtime, and fails with a font-parser error that names neither this
 * file nor the font. Do not fold these two into a helper that takes a filename.
 */
const GEIST_URL = new URL("../assets/og/Geist-Regular.ttf", import.meta.url);
const EMOJI_URL = new URL("../assets/og/NotoEmoji-Regular.woff", import.meta.url);

async function load(url: URL, name: string): Promise<OgFont> {
  let bytes: Buffer;
  try {
    bytes = await readFile(url);
  } catch (error: unknown) {
    throw new Error(
      `OG font ${name} could not be read from ${url.pathname}. It is committed under apps/web/assets/og; a bundler that dropped it will render blank cards, not an error.`,
      { cause: error },
    );
  }
  return {
    name,
    data: bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer,
    weight: 400,
    style: "normal",
  };
}

/**
 * Text face first, emoji second. Satori resolves per glyph in order, so the Latin face wins
 * for anything it covers and the emoji face catches the rest.
 */
export function ogFonts(): Promise<readonly OgFont[]> {
  cached ??= Promise.all([load(GEIST_URL, "Geist"), load(EMOJI_URL, "NotoEmoji")]);
  return cached;
}
