import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { FirewallRule } from "@gsm/shared";
import { post } from "./client";
import { instanceKeys } from "./instances";

/** An owner opens (true) or closes (false) the instance's ports in its node's firewall. */
export function useInstanceFirewall(id: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (open: boolean) =>
      post<{ rules: FirewallRule[] }>(`/instances/${id}/firewall`, { open }),
    onSuccess: () => qc.invalidateQueries({ queryKey: instanceKeys.all }),
  });
}
