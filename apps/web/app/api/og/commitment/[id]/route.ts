/**
 * GET /api/og/commitment/:id — the card a link to a commitment unfurls into.
 *
 * INVARIANT I-1: reads `commitment.status`, writes nothing. A card is a rendering of the
 * record and has no opinion about it.
 *
 * Node runtime, not edge: the fonts are read from disk (lib/og-fonts.ts) and the query runs
 * through postgres.js.
 */
import { commitmentCard } from "@/lib/og-card";
import { getCommitmentCardData } from "@/lib/og-data";
import { renderOgCard } from "@/lib/og-render";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  const { id } = await context.params;

  const data = await getCommitmentCardData(id);
  if (data === undefined) {
    return new Response("not found", { status: 404 });
  }

  return renderOgCard(commitmentCard(data));
}
