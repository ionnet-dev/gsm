import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ConsoleLine,
  ConsoleStream,
  CreateInstanceBody,
  InstanceAccessDto,
  InstanceDetailDto,
  InstanceDto,
  InstanceRole,
  InstanceStats,
  InstanceStatus,
  InstanceSummary,
  Page,
  PowerAction,
  UpdateInstanceBody,
} from "@gsm/shared";
import type { AuditEntryDto } from "./users";
import { api, del, get, patch, post } from "./client";

export interface InstanceListParams {
  page?: number;
  pageSize?: number;
  nodeId?: number;
  templateId?: number;
  status?: InstanceStatus;
  q?: string;
  sort?: "name" | "status" | "createdAt" | "node";
  dir?: "asc" | "desc";
}

export const instanceKeys = {
  all: ["instances"] as const,
  list: (p: InstanceListParams) => ["instances", "list", p] as const,
  summary: ["instances", "summary"] as const,
  detail: (id: number) => ["instances", "detail", id] as const,
  console: (id: number, stream: ConsoleStream) => ["instances", "console", id, stream] as const,
  access: (id: number) => ["instances", "access", id] as const,
  activity: (id: number, page: number) => ["instances", "activity", id, page] as const,
};

export const useInstances = (params: InstanceListParams) =>
  useQuery({
    queryKey: instanceKeys.list(params),
    queryFn: () => get<Page<InstanceDto>>("/instances", { ...params }),
    placeholderData: keepPreviousData,
  });

export const useInstanceSummary = () =>
  useQuery({
    queryKey: instanceKeys.summary,
    queryFn: () => get<InstanceSummary>("/instances/summary"),
  });

export const useInstance = (id: number) =>
  useQuery({
    queryKey: instanceKeys.detail(id),
    queryFn: () => get<{ instance: InstanceDetailDto }>(`/instances/${id}`),
    select: (d) => d.instance,
  });

/** The tail of the console log from the node; read once per opening, live lines follow via the socket. */
export const useConsoleHistory = (id: number, stream: ConsoleStream, lines = 500) =>
  useQuery({
    queryKey: instanceKeys.console(id, stream),
    queryFn: () => get<{ lines: ConsoleLine[] }>(`/instances/${id}/console`, { stream, lines }),
    select: (d) => d.lines,
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
  });

export const useInstanceAccess = (id: number) =>
  useQuery({
    queryKey: instanceKeys.access(id),
    queryFn: () => get<{ items: InstanceAccessDto[] }>(`/instances/${id}/access`),
    select: (d) => d.items,
  });

export const useInstanceActivity = (id: number, page: number) =>
  useQuery({
    queryKey: instanceKeys.activity(id, page),
    queryFn: () => get<Page<AuditEntryDto>>(`/instances/${id}/activity`, { page, pageSize: 50 }),
    placeholderData: keepPreviousData,
  });

export function useInstanceMutations() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: instanceKeys.all });
  return {
    create: useMutation({
      mutationFn: (body: CreateInstanceBody) =>
        post<{ instance: InstanceDetailDto }>("/instances", body),
      onSuccess: invalidate,
    }),
    update: useMutation({
      mutationFn: ({ id, ...body }: UpdateInstanceBody & { id: number }) =>
        patch<{ instance: InstanceDetailDto }>(`/instances/${id}`, body),
      onSuccess: invalidate,
    }),
    remove: useMutation({
      mutationFn: ({ id, keepFiles }: { id: number; keepFiles: boolean }) =>
        api<{ ok: true }>(`/instances/${id}`, {
          method: "DELETE",
          query: { keepFiles: keepFiles ? "1" : undefined },
        }),
      onSuccess: invalidate,
    }),
    power: useMutation({
      mutationFn: ({ id, action }: { id: number; action: PowerAction }) =>
        post<{ instance: InstanceDetailDto }>(`/instances/${id}/power`, { action }),
      onSuccess: invalidate,
    }),
    command: useMutation({
      mutationFn: ({ id, command }: { id: number; command: string }) =>
        post<{ ok: true }>(`/instances/${id}/command`, { command }),
    }),
    reinstall: useMutation({
      mutationFn: (id: number) => post<{ ok: true }>(`/instances/${id}/reinstall`),
      onSuccess: invalidate,
    }),
    grant: useMutation({
      mutationFn: ({ id, userId, role }: { id: number; userId: number; role: InstanceRole }) =>
        api<{ items: InstanceAccessDto[] }>(`/instances/${id}/access`, {
          method: "PUT",
          json: { userId, role },
        }),
      onSuccess: (_r, v) => {
        qc.invalidateQueries({ queryKey: instanceKeys.access(v.id) });
        qc.invalidateQueries({ queryKey: ["users"] });
      },
    }),
    revoke: useMutation({
      mutationFn: ({ id, userId }: { id: number; userId: number }) =>
        del<{ ok: true }>(`/instances/${id}/access/${userId}`),
      onSuccess: (_r, v) => {
        qc.invalidateQueries({ queryKey: instanceKeys.access(v.id) });
        qc.invalidateQueries({ queryKey: ["users"] });
      },
    }),
  };
}

/** Patch a status/stats change into every cached list and the detail, without a refetch. */
export function patchInstanceCaches(
  qc: ReturnType<typeof useQueryClient>,
  instanceId: number,
  patchFn: (i: InstanceDto) => InstanceDto,
) {
  qc.setQueriesData<Page<InstanceDto>>(
    { queryKey: ["instances", "list"] },
    (page) =>
      page
        ? { ...page, items: page.items.map((i) => (i.id === instanceId ? patchFn(i) : i)) }
        : page,
  );
  qc.setQueryData<{ instance: InstanceDetailDto }>(
    instanceKeys.detail(instanceId),
    (old) => old ? { instance: patchFn(old.instance) as InstanceDetailDto } : old,
  );
}

export type { InstanceStats };
