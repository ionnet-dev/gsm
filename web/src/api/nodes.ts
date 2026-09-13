import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CreateEnrollmentTokenBody,
  EnrollmentTokenDto,
  ImageInfo,
  NodeDetailDto,
  NodeDto,
  NodeSummary,
  Page,
  UpdateNodeBody,
} from "@gsm/shared";
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

export const useNodeSummary = (enabled = true) =>
  useQuery({
    queryKey: nodeKeys.summary,
    queryFn: () => get<NodeSummary>("/nodes/summary"),
    enabled,
  });

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
