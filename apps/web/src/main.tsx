import "./index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRootRoute, createRoute, createRouter, Outlet, redirect, RouterProvider, useNavigate } from "@tanstack/react-router";
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";

import { getToken, Unauthorized, useSignedIn } from "./api.ts";
import { RepoShell } from "./components/layout.tsx";
import { LoginPage, ReposPage } from "./pages/entry.tsx";
import { FindingPage, FindingsPage } from "./pages/findings.tsx";
import { CoveragePage, SettingsPage } from "./pages/misc.tsx";
import { OverviewPage } from "./pages/overview.tsx";
import { PledgePage, PledgesPage } from "./pages/pledges.tsx";
import { RunPage, RunsPage } from "./pages/runs.tsx";

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 15_000, retry: (count, error) => !(error instanceof Unauthorized) && count < 2 } },
});

/** Leaves for the sign-in page whenever the session ends, wherever that happens. */
function Root() {
  const signedIn = useSignedIn();
  const navigate = useNavigate();
  useEffect(() => {
    if (!signedIn && location.pathname !== "/login") {
      queryClient.clear();
      void navigate({ to: "/login" });
    }
  }, [signedIn, navigate]);
  return <Outlet />;
}

const requireSession = () => {
  if (!getToken()) throw redirect({ to: "/login" });
};
const statusSearch = (search: Record<string, unknown>): { status?: string } => (typeof search.status === "string" ? { status: search.status } : {});

const root = createRootRoute({ component: Root });
const repo = createRoute({ getParentRoute: () => root, path: "/r/$repoId", component: RepoShell, beforeLoad: requireSession });

const routeTree = root.addChildren([
  createRoute({ getParentRoute: () => root, path: "/", beforeLoad: () => { throw redirect({ to: getToken() ? "/repos" : "/login" }); } }),
  createRoute({ getParentRoute: () => root, path: "/login", component: LoginPage }),
  createRoute({ getParentRoute: () => root, path: "/repos", component: ReposPage, beforeLoad: requireSession }),
  repo.addChildren([
    createRoute({ getParentRoute: () => repo, path: "/", beforeLoad: ({ params }) => { throw redirect({ to: "/r/$repoId/overview", params }); } }),
    createRoute({ getParentRoute: () => repo, path: "overview", component: OverviewPage }),
    createRoute({ getParentRoute: () => repo, path: "findings", component: FindingsPage, validateSearch: statusSearch }),
    createRoute({ getParentRoute: () => repo, path: "findings/$findingId", component: FindingPage }),
    createRoute({ getParentRoute: () => repo, path: "pledges", component: PledgesPage, validateSearch: statusSearch }),
    createRoute({ getParentRoute: () => repo, path: "pledges/$pledgeId", component: PledgePage }),
    createRoute({ getParentRoute: () => repo, path: "coverage", component: CoveragePage }),
    createRoute({ getParentRoute: () => repo, path: "runs", component: RunsPage }),
    createRoute({ getParentRoute: () => repo, path: "runs/$runId", component: RunPage }),
    createRoute({ getParentRoute: () => repo, path: "settings", component: SettingsPage }),
  ]),
]);

const router = createRouter({ routeTree, defaultNotFoundComponent: () => <p className="p-8 text-ink-2">There is no page at this address.</p> });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

createRoot(document.querySelector("#app")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
