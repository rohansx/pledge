import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";

import { api } from "./api.ts";
import type { Finding, FindingDetail, FindingStatus, Me, Overview, Pledge, PledgeDetail, Repo, Run, RunDetail } from "./types.ts";

// One query per API call. Keys start with the object kind so a mutation can invalidate everything derived from it.
export const meQuery = () => queryOptions({ queryKey: ["me"], queryFn: () => api<Me>("/me") });
export const reposQuery = () => queryOptions({ queryKey: ["repos"], queryFn: () => api<Repo[]>("/repos") });
export const overviewQuery = (repoId: string) => queryOptions({ queryKey: ["repo", repoId, "overview"], queryFn: () => api<Overview>(`/repos/${repoId}/overview`) });
export const findingsQuery = (repoId: string, status?: string) => queryOptions({ queryKey: ["repo", repoId, "findings", status ?? "all"], queryFn: () => api<Finding[]>(`/repos/${repoId}/findings${status ? `?status=${status}` : ""}`) });
export const findingQuery = (id: string) => queryOptions({ queryKey: ["finding", id], queryFn: () => api<FindingDetail>(`/findings/${id}`) });
export const pledgesQuery = (repoId: string, status?: string) => queryOptions({ queryKey: ["repo", repoId, "pledges", status ?? "all"], queryFn: () => api<Pledge[]>(`/repos/${repoId}/pledges${status ? `?status=${status}` : ""}`) });
export const pledgeQuery = (id: string) => queryOptions({ queryKey: ["pledge", id], queryFn: () => api<PledgeDetail>(`/pledges/${encodeURIComponent(id)}`) });
export const runsQuery = (repoId: string) => queryOptions({ queryKey: ["repo", repoId, "runs"], queryFn: () => api<Run[]>(`/repos/${repoId}/runs`) });
export const runQuery = (id: string) => queryOptions({ queryKey: ["run", id], queryFn: () => api<RunDetail>(`/runs/${id}`) });
export const commentQuery = (id: string) => queryOptions({ queryKey: ["run", id, "comment"], queryFn: () => api<{ markdown: string }>(`/runs/${id}/comment`) });

/** After a decision, everything about the repo may read differently: verdicts depend on which pledges are approved. */
export function useDecidePledge(repoId: string, pledgeId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: { action: "approve" | "reject" | "retire"; override?: boolean; note?: string }) => api<PledgeDetail>(`/pledges/${encodeURIComponent(pledgeId)}`, { method: "PATCH", body }),
    onSuccess: () => Promise.all([client.invalidateQueries({ queryKey: ["repo", repoId] }), client.invalidateQueries({ queryKey: ["pledge"] }), client.invalidateQueries({ queryKey: ["finding"] }), client.invalidateQueries({ queryKey: ["run"] }), client.invalidateQueries({ queryKey: ["repos"] })]),
  });
}

export function useSetFindingStatus(repoId: string, findingId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (status: Extract<FindingStatus, "open" | "fix_proposed" | "fixed_unverified">) => api<FindingDetail>(`/findings/${findingId}`, { method: "PATCH", body: { status } }),
    onSuccess: () => Promise.all([client.invalidateQueries({ queryKey: ["repo", repoId] }), client.invalidateQueries({ queryKey: ["finding", findingId] }), client.invalidateQueries({ queryKey: ["repos"] })]),
  });
}
