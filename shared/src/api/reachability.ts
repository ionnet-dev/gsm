/**
 * Whether players and SFTP clients can reach an instance from outside, as checked from the panel
 * server: its connection goes to the node's public address, like a player's would.
 */

/**
 * `open`: reachable. `closed`: refused (nothing listens, or a firewall rejects it). `timeout`: no
 * answer (a firewall drops it, or the port is not forwarded). `error`: something else (the address
 * does not resolve, another program has the port, …). `untested`: could not be checked now.
 */
export const REACHABILITY_STATUSES = ["open", "closed", "timeout", "error", "untested"] as const;
export type ReachabilityStatus = (typeof REACHABILITY_STATUSES)[number];

export interface PortReachability {
  /** The template port's name and label. */
  name: string;
  label: string;
  port: number;
  protocol: "tcp" | "udp";
  status: ReachabilityStatus;
  /** What happened, for people; null when reachable. */
  detail: string | null;
  /** `probe`: the agent listened while the server was stopped; `connect`: the running server answered. */
  method: "probe" | "connect" | null;
  checkedAt: string;
}

export interface InstanceReachability {
  /** The address the check connected to. */
  host: string;
  checkedAt: string;
  ports: PortReachability[];
}

export interface SftpReachability {
  host: string;
  port: number;
  status: ReachabilityStatus;
  detail: string | null;
  checkedAt: string;
}
