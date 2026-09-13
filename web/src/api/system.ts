import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AgentReleaseDto, AgentReleaseSummary } from "@gsm/shared";
import { del, get, post } from "./client";

export const systemKeys = {
  releases: ["agent-releases"] as const,
  health: ["health"] as const,
};

export const useHealth = () =>
  useQuery({
    queryKey: systemKeys.health,
    queryFn: () => get<{ status: string; version?: string; db: string }>("/health"),
    staleTime: 3_600_000,
  });

export const useReleases = () =>
  useQuery({
    queryKey: systemKeys.releases,
    queryFn: () =>
      get<{ items: AgentReleaseDto[]; summary: AgentReleaseSummary }>("/agent-releases"),
  });

export function useReleaseMutations() {
  const qc = useQueryClient();
  const done = () => qc.invalidateQueries({ queryKey: systemKeys.releases });
  return {
    upload: useMutation({
      mutationFn: async (form: FormData) => {
        const res = await fetch("/api/v1/agent-releases", {
          method: "POST",
          body: form,
          headers: { "x-gsm-client": "web" },
          credentials: "same-origin",
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error?.message ?? `Upload failed (${res.status})`);
        return body as { release: AgentReleaseDto };
      },
      onSuccess: done,
    }),
    setLatest: useMutation({
      mutationFn: (id: number) =>
        post<{ release: AgentReleaseDto }>(`/agent-releases/${id}/latest`),
      onSuccess: done,
    }),
    remove: useMutation({
      mutationFn: (id: number) => del<{ ok: true }>(`/agent-releases/${id}`),
      onSuccess: done,
    }),
    rollout: useMutation({
      mutationFn: () =>
        post<{ updated: number[]; failed: number[]; skipped: number }>("/agent-releases/rollout"),
      onSuccess: done,
    }),
  };
}
