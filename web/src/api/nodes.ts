import {
  keepPreviousData,
  type QueryClient,
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type {
  CreateEnrollmentTokenBody,
  EnrollmentTokenDto,
  ImageInfo,
  NodeAccessDto,
  NodeDetailDto,
  NodeDto,
  NodeSummary,
  Page,
  UpdateNodeBody,
} from "@gsm/shared";
import { authStatusQuery, useAuth } from "./auth";
import { api, del, get, patch, post } from "./client";

export interface NodeListParams {
  page?: number;
  pageSize?: number;
  status?: "online" | "offline";
  q?: string;
}

export const nodeKeys = {
  all: ["nodes"] as const,
  list: (p: NodeListParams) => ["nodes", "list", p] as const,
  every: ["nodes", "all"] as const,
  summary: ["nodes", "summary"] as const,
  detail: (id: number) => ["nodes", "detail", id] as const,
  images: (id: number) => ["nodes", "images", id] as const,
  access: (id: number) => ["nodes", "access", id] as const,
  tokens: ["enrollment-tokens"] as const,
};

export const useNodes = (params: NodeListParams, enabled = true) =>
  useQuery({
    queryKey: nodeKeys.list(params),
    queryFn: () => get<Page<NodeDto>>("/nodes", { ...params }),
    placeholderData: keepPreviousData,
    enabled,
  });

/** Every node, for pickers. */
export const useAllNodes = (enabled = true) =>
  useQuery({
    queryKey: nodeKeys.every,
    queryFn: () => get<{ items: NodeDto[] }>("/nodes/all"),
    select: (d) => d.items,
    enabled,
  });

/** Counts over the nodes the requester manages (every node for admins). */
export const nodeSummaryQuery = queryOptions({
  queryKey: nodeKeys.summary,
  queryFn: () => get<NodeSummary>("/nodes/summary"),
});

export const useNodeSummary = () => useQuery(nodeSummaryQuery);

/** Admins manage every node; other users the nodes an admin made them owner of. */
export function useManagesNodes(): boolean {
  const { admin } = useAuth();
  const { data } = useNodeSummary();
  return admin || (data?.total ?? 0) > 0;
}

/** `useManagesNodes` for route guards. */
export async function managesNodes(qc: QueryClient): Promise<boolean> {
  const status = await qc.ensureQueryData(authStatusQuery);
  if (!status.user) return false;
  if (status.user.role === "admin") return true;
  return (await qc.ensureQueryData(nodeSummaryQuery)).total > 0;
}

export const useNode = (id: number) =>
  useQuery({
    queryKey: nodeKeys.detail(id),
    queryFn: () => get<{ node: NodeDetailDto; connected: boolean }>(`/nodes/${id}`),
  });

export const useNodeImages = (id: number, enabled = true) =>
  useQuery({
    queryKey: nodeKeys.images(id),
    queryFn: () => get<{ images: ImageInfo[] }>(`/nodes/${id}/images`),
    select: (d) => d.images,
    enabled,
    retry: false,
  });

/** The node's owners: they manage it and own every instance on it. */
export const useNodeAccess = (id: number) =>
  useQuery({
    queryKey: nodeKeys.access(id),
    queryFn: () => get<{ items: NodeAccessDto[] }>(`/nodes/${id}/access`),
    select: (d) => d.items,
  });

export function useNodeMutations() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: nodeKeys.all });
  return {
    update: useMutation({
      mutationFn: ({ id, ...body }: UpdateNodeBody & { id: number }) =>
        patch<{ node: NodeDetailDto }>(`/nodes/${id}`, body),
      onSuccess: invalidate,
    }),
    remove: useMutation({
      mutationFn: (id: number) => del<{ ok: true }>(`/nodes/${id}`),
      onSuccess: invalidate,
    }),
    ping: useMutation({
      mutationFn: (id: number) =>
        post<{ at: string; agentVersion: string; rttMs: number }>(`/nodes/${id}/ping`),
    }),
    refresh: useMutation({
      mutationFn: (id: number) => post<{ node: NodeDetailDto }>(`/nodes/${id}/refresh`),
      onSuccess: invalidate,
    }),
    pullImage: useMutation({
      mutationFn: ({ id, ref }: { id: number; ref: string }) =>
        post<{ ok: true }>(`/nodes/${id}/images/pull`, { ref }),
    }),
    removeImage: useMutation({
      mutationFn: ({ id, ref }: { id: number; ref: string }) =>
        api<{ ok: true }>(`/nodes/${id}/images`, { method: "DELETE", query: { ref } }),
      onSuccess: (_r, v) => qc.invalidateQueries({ queryKey: nodeKeys.images(v.id) }),
    }),
    grant: useMutation({
      mutationFn: ({ id, userId }: { id: number; userId: number }) =>
        api<{ items: NodeAccessDto[] }>(`/nodes/${id}/access`, {
          method: "PUT",
          json: { userId },
        }),
      onSuccess: invalidate,
    }),
    revoke: useMutation({
      mutationFn: ({ id, userId }: { id: number; userId: number }) =>
        del<{ items: NodeAccessDto[] }>(`/nodes/${id}/access/${userId}`),
      onSuccess: invalidate,
    }),
  };
}

export const useEnrollmentTokens = () =>
  useQuery({
    queryKey: nodeKeys.tokens,
    queryFn: () => get<{ items: EnrollmentTokenDto[] }>("/enrollment-tokens"),
    select: (d) => d.items,
  });

export function useEnrollmentMutations() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: nodeKeys.tokens });
  return {
    create: useMutation({
      mutationFn: (body: CreateEnrollmentTokenBody) =>
        post<{ token: EnrollmentTokenDto; plaintext: string }>("/enrollment-tokens", body),
      onSuccess: invalidate,
    }),
    revoke: useMutation({
      mutationFn: (id: number) => post<{ ok: true }>(`/enrollment-tokens/${id}/revoke`),
      onSuccess: invalidate,
    }),
  };
}
