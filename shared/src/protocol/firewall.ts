/**
 * The node's firewall, driven by the agent (ufw or firewalld). The agent only removes rules it
 * added; a rule that was there already is "existing" and left alone. Mirrored in
 * agent/internal/protocol/types.go.
 */
import { z } from "zod";

export const FIREWALL_BACKENDS = ["ufw", "firewalld"] as const;
export type FirewallBackend = (typeof FIREWALL_BACKENDS)[number];

export const FirewallPort = z.object({
  port: z.number().int().min(1).max(65535),
  protocol: z.enum(["tcp", "udp"]),
});
export type FirewallPort = z.infer<typeof FirewallPort>;

/** `open`: added by the agent. `existing`: it was open already. `error`: see `error`. */
export const FIREWALL_RULE_STATES = ["open", "existing", "error"] as const;

export const FirewallRule = FirewallPort.extend({
  state: z.enum(FIREWALL_RULE_STATES),
  error: z.string().nullable(),
});
export type FirewallRule = z.infer<typeof FirewallRule>;

/** Sent in agent.configure: may the agent change the node's firewall? */
export const FirewallConfig = z.object({ managed: z.boolean() });

/** The agent's answer in agent.configure: which firewall runs, and the SFTP port's rule. */
export const FirewallStatus = z.object({
  backend: z.enum(FIREWALL_BACKENDS).nullable(),
  managed: z.boolean(),
  error: z.string().nullable(),
  sftp: z.array(FirewallRule),
});
export type FirewallStatus = z.infer<typeof FirewallStatus>;

export const FirewallApplyResult = z.object({
  backend: z.enum(FIREWALL_BACKENDS).nullable(),
  rules: z.array(FirewallRule),
});

export const firewallMethods = {
  /** Make the agent's rules for an instance exactly `ports` (`[]` removes them). */
  "fw.apply": {
    params: z.object({
      key: z.string().regex(/^instance:[0-9a-f-]{8,64}$/),
      ports: z.array(FirewallPort).max(32),
    }),
    result: FirewallApplyResult,
  },
} as const;
