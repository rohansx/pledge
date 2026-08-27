/**
 * POST /api/v1/witness/attest — the one endpoint in pledge that requires no account.
 *
 * ADR-0006: a witness is doing the committer a favour, once, usually from a phone, and every
 * signup step in front of a favour is a step at which the favour does not happen. So the
 * credential here is the signed link and nothing else.
 *
 * INVARIANT I-1: no status literal in this file. The handler in lib/witness.ts can reach
 * `disputed` and nothing beyond it — an accountless caller cannot manufacture a success, which
 * is what makes the weak identity assurance of a magic link tolerable at all.
 *
 * NO CSRF TOKEN, deliberately. The credential is a bearer secret in the URL, not an ambient
 * cookie, so a cross-site POST from an attacker who does not hold the token authenticates as
 * nobody — and one who does hold it can simply open the link. Adding a CSRF token would guard
 * a session this endpoint does not have.
 *
 * Accepts a form post (the no-JavaScript path from /w/<token>, answered with a redirect) and a
 * JSON post (answered with JSON). Both run the same schema and the same handler.
 */
import { NextResponse } from "next/server";
import { recordAttestation } from "@/lib/witness";
import { WitnessAttestInputSchema } from "@/lib/witness-input";
import { parseWitnessToken, witnessTokenRefusal } from "@/lib/witness-token";

export async function POST(request: Request): Promise<NextResponse> {
  const wantsHtml = isFormPost(request);

  const body = await readBody(request);
  if (body === undefined) {
    return fail(wantsHtml, undefined, "body must be JSON or a form post", 400);
  }

  const parsed = WitnessAttestInputSchema.safeParse(body);
  if (!parsed.success) {
    return fail(wantsHtml, undefined, "invalid attestation", 400);
  }
  const input = parsed.data;

  // Signature and expiry, offline. A forged link costs one HMAC and never reaches the
  // database.
  const token = parseWitnessToken(input.token);
  if (!token.ok) {
    return fail(wantsHtml, input.token, witnessTokenRefusal(), 410);
  }

  const result = await recordAttestation({
    tokenHash: token.tokenHash,
    verdict: input.verdict,
    note: input.note,
  });

  if (!result.ok) {
    // "already used", "expired" and "no such witness" all answer 410 with one sentence. The
    // page the redirect lands on can be more specific, because by then the link has been
    // looked up; the API is not in the business of confirming which ids exist.
    return fail(wantsHtml, input.token, witnessTokenRefusal(), 410);
  }

  if (wantsHtml) {
    // 303: the browser must follow with GET, so a refresh of the result page does not re-post
    // an attestation that is single-use anyway.
    return NextResponse.redirect(new URL(`/w/${input.token}`, request.url), 303);
  }

  return NextResponse.json(
    {
      commitmentId: result.commitmentId,
      verdict: result.verdict,
      // What actually happened to the record. `contested: false` means the attestation was
      // recorded and changed no outcome, which is the common and correct case.
      contested: result.contested,
    },
    { status: 201 },
  );
}

function isFormPost(request: Request): boolean {
  const type = request.headers.get("content-type") ?? "";
  return (
    type.startsWith("application/x-www-form-urlencoded") ||
    type.startsWith("multipart/form-data")
  );
}

async function readBody(request: Request): Promise<unknown> {
  try {
    if (isFormPost(request)) {
      return Object.fromEntries(await request.formData());
    }
    return await request.json();
  } catch {
    return undefined;
  }
}

/**
 * One refusal shape for both callers. The form path bounces back to `/w/<token>`, which
 * re-derives the reason from the link itself rather than carrying it in a query string where
 * it would be attacker-settable.
 */
function fail(
  wantsHtml: boolean,
  token: string | undefined,
  message: string,
  status: number,
): NextResponse {
  if (wantsHtml && token !== undefined) {
    return NextResponse.redirect(
      new URL(
        `/w/${encodeURIComponent(token)}`,
        process.env["NEXT_PUBLIC_BASE_URL"] ?? "http://localhost:3000",
      ),
      303,
    );
  }
  return NextResponse.json({ error: message }, { status });
}
