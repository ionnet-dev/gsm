import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { InstancePlayersDto, PlayerActionBody } from "@gsm/shared";
import { get, post } from "./client";

export const playerKeys = {
  list: (instanceId: number) => ["instances", "players", instanceId] as const,
};

/** Who is online, recent players, the game's lists and the actions; `instance.players` refetches. */
export const usePlayers = (instanceId: number) =>
  useQuery({
    queryKey: playerKeys.list(instanceId),
    queryFn: () => get<InstancePlayersDto>(`/instances/${instanceId}/players`),
  });

export function usePlayerMutations(instanceId: number) {
  const qc = useQueryClient();
  return {
    /** The game's lists follow through `instance.players` once it has written its files. */
    action: useMutation({
      mutationFn: (body: PlayerActionBody) =>
        post<{ ok: true; command: string }>(`/instances/${instanceId}/players/actions`, body),
    }),
    refresh: useMutation({
      mutationFn: () => post<{ ok: true }>(`/instances/${instanceId}/players/refresh`),
      onSuccess: () => qc.invalidateQueries({ queryKey: playerKeys.list(instanceId) }),
    }),
  };
}
