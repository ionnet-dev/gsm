import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { InstanceDatabaseDto } from "@gsm/shared";
import { get, post } from "./client";
import { fileKeys } from "./files";

export const databaseKeys = {
  // Under "instances" so an `instance.updated` (database turned on or off, new image) refetches it.
  detail: (instanceId: number) => ["instances", "database", instanceId] as const,
};

/** How the game reaches the instance's database, password included (`settings` roles only). */
export const useInstanceDatabase = (instanceId: number, enabled = true) =>
  useQuery({
    queryKey: databaseKeys.detail(instanceId),
    queryFn: () => get<{ database: InstanceDatabaseDto }>(`/instances/${instanceId}/database`),
    select: (d) => d.database,
    enabled,
  });

/** Write a gzipped SQL dump into the instance's files; null = the server's default path. */
export function useDumpDatabase(instanceId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: { path: string | null }) =>
      post<{ path: string; size: number }>(`/instances/${instanceId}/database/dump`, b),
    onSuccess: () => qc.invalidateQueries({ queryKey: [...fileKeys.all(instanceId), "dir"] }),
  });
}

/** Replace the database's contents with a .sql or .sql.gz file from the instance's files. */
export function useImportDatabase(instanceId: number) {
  return useMutation({
    mutationFn: (b: { path: string }) =>
      post<{ ok: true }>(`/instances/${instanceId}/database/import`, b),
  });
}
