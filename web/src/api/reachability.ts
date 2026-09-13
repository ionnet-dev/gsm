import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { InstanceReachability, SftpReachability } from "@gsm/shared";
import { post } from "./client";
import { instanceKeys } from "./instances";
import { nodeKeys } from "./nodes";

/** Check an instance's ports and its node's SFTP from the panel server now. */
export function useInstanceReachabilityCheck(id: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      post<{ reachability: InstanceReachability; sftp: SftpReachability | null }>(
        `/instances/${id}/reachability`,
      ),
    // Instance and SFTP details both live under the "instances" key.
    onSuccess: () => qc.invalidateQueries({ queryKey: instanceKeys.all }),
  });
}

export function useNodeSftpCheck(nodeId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => post<{ sftp: SftpReachability | null }>(`/nodes/${nodeId}/sftp/check`),
    onSuccess: () => qc.invalidateQueries({ queryKey: nodeKeys.all }),
  });
}
