import type { Metadata, Viewport } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { auth } from "@/auth";
import "./globals.css";

// ADR-0009: the name is forward-looking, the product is backward-looking. Every surface
// leads with the record, not the promise.
export const metadata: Metadata = {
  title: {
    default: "pledge — the record of what you shipped",
    template: "%s",
  },
  description:
    "A verifiable record of shipping commitments. Outcomes are resolved by probes against " +
    "external state, never self-reported.",
  metadataBase: new URL(process.env["NEXT_PUBLIC_BASE_URL"] ?? "http://localhost:3000"),
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const session = await auth();

  return (
    <html lang="en">
      <body>
        <nav className="nav">
          <Link className="wordmark" href="/">
            pledge
          </Link>
          {session?.user.handle !== undefined ? (
            <span className="nav-right">
              <Link href={`/${session.user.handle}` as const}>your record</Link>
              <Link href="/new">commit</Link>
            </span>
          ) : (
            <span className="nav-right">
              <Link href="/new">commit</Link>
            </span>
          )}
        </nav>
        {children}
        <footer className="footer">
          Outcomes are observed, not reported. Every badge links to the criterion that produced
          it.
        </footer>
      </body>
    </html>
  );
}
