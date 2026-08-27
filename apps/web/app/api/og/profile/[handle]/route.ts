/**
 * GET /api/og/profile/:handle — the card a link to a profile unfurls into.
 *
 * The handle is rendered verbatim, emoji and all. That is a v1 exit criterion rather than a
 * nicety: a handle is arbitrary text, and a font stack that silently drops what it cannot draw
 * produces a card of empty boxes with no error anywhere. See lib/og-fonts.ts.
 *
 * INVARIANT I-1: reads statuses to count them, writes nothing.
 */
import { profileCard } from "@/lib/og-card";
import { getProfileCardData } from "@/lib/og-data";
import { renderOgCard } from "@/lib/og-render";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ handle: string }>;
}

export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  const { handle } = await context.params;

  const data = await getProfileCardData(decodeURIComponent(handle));
  if (data === undefined) {
    return new Response("not found", { status: 404 });
  }

  return renderOgCard(profileCard(data));
}
