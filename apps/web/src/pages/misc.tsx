import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { setToken } from "../api.ts";
import { Button, Empty, PageTitle } from "../components/ui.tsx";
import { meQuery } from "../queries.ts";

export function CoveragePage() {
  return (
    <>
      <PageTitle title="Coverage" lede="Which of the repo's routes a pledge exercises, which faults have been tried on each, and which routes that write money, stock, credits or customer data have no approved pledge." />
      <Empty title="Coverage is not built yet.">
        <p>The boot step already lists a repo's routes, but nothing yet maps the requests a scenario makes onto them, so there is no grid to show. Until then, the Pledges tab shows what is checked, and each run shows the faults it used.</p>
      </Empty>
    </>
  );
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid grid-cols-1 gap-x-6 gap-y-2 border-b border-line px-5 py-5 last:border-b-0 md:grid-cols-[180px_minmax(0,1fr)]">
      <h2 className="text-sm font-medium">{title}</h2>
      <div className="max-w-[62ch] text-sm text-ink-2 [&_code]:rounded-xs [&_code]:bg-paper-2 [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[12.5px] [&_code]:text-ink [&_p+p]:mt-3">{children}</div>
    </section>
  );
}

export function SettingsPage() {
  const { repoId } = useParams({ strict: false }) as { repoId: string };
  const me = useQuery(meQuery());
  const navigate = useNavigate();
  const repo = me.data?.repos.find((candidate) => candidate.id === repoId);
  return (
    <>
      <PageTitle title="Settings" />
      <div className="mt-6 overflow-hidden rounded-xl border border-line bg-card shadow-xs">
        <Block title="Repo">
          <p><b className="font-medium text-ink">{repo?.name ?? repoId}</b>. Created when the command line first published a run under this name.</p>
        </Block>
        <Block title="Sending runs here">
          <p>The dashboard shows what the command line sends. With the token in <code>PLEDGE_API_TOKEN</code>:</p>
          <pre className="mt-3 overflow-x-auto rounded-lg border border-line bg-paper-2/60 px-4 py-3.5 font-mono text-xs leading-relaxed text-ink">{`pledge author <repo> --out <dir> --publish --app ${repoId}\npledge scan <dir> --scenario <name> --faults <file> --seeds 5 --publish --app ${repoId}`}</pre>
          <p>A published run appears under Runs while it is still working.</p>
        </Block>
        <Block title="Account">
          <p>Signed in as <b className="font-medium text-ink">{me.data?.user.name ?? "…"}</b>: one token shared by everyone who has it. Personal accounts and team roles come with GitHub sign-in.</p>
          <p><Button onClick={() => { setToken(null); void navigate({ to: "/login" }); }}>Sign out of this browser</Button></p>
        </Block>
      </div>
    </>
  );
}
