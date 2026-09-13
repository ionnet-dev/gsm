import { z } from "zod";
import type { FirewallBackend, FirewallRule } from "../protocol/firewall.ts";

/** An instance's ports in its node's firewall, as its owners manage them. */
export interface InstanceFirewallDto {
  /** Whether the node lets the panel change its firewall (its "Manage firewall" switch). */
  managed: boolean;
  backend: FirewallBackend | null;
  /** Why the ports cannot be opened from here now, if they cannot. */
  problem: string | null;
  /** An owner opened the instance's ports; they follow port changes until closed. */
  open: boolean;
  /** The last result for the instance's ports. */
  rules: FirewallRule[];
  /** The node's SFTP port rule. */
  sftp: FirewallRule[];
  updatedAt: string | null;
}

export const SetInstanceFirewallBody = z.object({ open: z.boolean() });
