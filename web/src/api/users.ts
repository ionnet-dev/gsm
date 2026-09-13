import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Page, PublicUser, Role } from "@gsm/shared";
import { del, get, patch, post } from "./client";

export interface AuditEntryDto {
  id: number;
  action: string;
  targetType: string | null;
  targetId: number | null;
  details: Record<string, unknown> | null;
  ip: string | null;
  createdAt: string;
  actor: { id: number; name: string; email: string } | null;
}

export interface DirectoryUser {
  id: number;
  name: string;
  email: string;
  role: Role;
}

export const useUsers = () =>
  useQuery({
    queryKey: ["users"],
    queryFn: () => get<{ items: PublicUser[] }>("/users"),
    select: (d) => d.items,
  });

/** Every enabled user, for sharing pickers (any signed-in user may read it). */
export const useUserDirectory = (enabled = true) =>
  useQuery({
    queryKey: ["users", "directory"],
    queryFn: () => get<{ items: DirectoryUser[] }>("/users/directory"),
    select: (d) => d.items,
    enabled,
    staleTime: 60_000,
  });

export function useUserMutations() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ["users"] });
  return {
    create: useMutation({
      mutationFn: (body: { email: string; name: string; password: string; role: Role }) =>
        post<{ user: PublicUser }>("/users", body),
      onSuccess: invalidate,
    }),
    update: useMutation({
      mutationFn: (
        { id, ...body }: {
          id: number;
          name?: string;
          role?: Role;
          disabled?: boolean;
          twoFactorEnabled?: false;
        },
      ) => patch<{ user: PublicUser }>(`/users/${id}`, body),
      onSuccess: invalidate,
    }),
    remove: useMutation({
      mutationFn: (id: number) => del<{ ok: true }>(`/users/${id}`),
      onSuccess: invalidate,
    }),
    resetPassword: useMutation({
      mutationFn: ({ id, password }: { id: number; password: string }) =>
        post<{ ok: true }>(`/users/${id}/password`, { password }),
    }),
  };
}

export const useAuditLog = (params: { page?: number; pageSize?: number; action?: string }) =>
  useQuery({
    queryKey: ["audit", params],
    queryFn: () => get<Page<AuditEntryDto>>("/audit", params),
  });
