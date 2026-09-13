import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { BackupDto } from "@gsm/shared";
import { del, get, post } from "./client";

export const backupKeys = {
  all: ["backups"] as const,
  list: (instanceId: number) => ["backups", instanceId] as const,
};

export const useBackups = (instanceId: number) =>
  useQuery({
    queryKey: backupKeys.list(instanceId),
    queryFn: () => get<{ items: BackupDto[] }>(`/instances/${instanceId}/backups`),
    select: (d) => d.items,
  });

export function useBackupMutations(instanceId: number) {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: backupKeys.list(instanceId) });
  const base = `/instances/${instanceId}/backups`;
  return {
    create: useMutation({
      mutationFn: (b: { name: string; ignore: string[] }) => post<{ backup: BackupDto }>(base, b),
      onSuccess: refresh,
    }),
    restore: useMutation({
      mutationFn: ({ backupId, wipe }: { backupId: string; wipe: boolean }) =>
        post<{ ok: true }>(`${base}/${backupId}/restore`, { wipe }),
      onSuccess: refresh,
    }),
    remove: useMutation({
      mutationFn: (backupId: string) => del<{ ok: true }>(`${base}/${backupId}`),
      onSuccess: refresh,
    }),
    download: useMutation({
      mutationFn: async (backupId: string) => {
        const r = await post<{ url: string; filename: string; size: number | null }>(
          `${base}/${backupId}/download`,
        );
        const a = document.createElement("a");
        a.href = r.url;
        a.download = r.filename;
        a.rel = "noopener";
        document.body.appendChild(a);
        a.click();
        a.remove();
        return r;
      },
    }),
  };
}
