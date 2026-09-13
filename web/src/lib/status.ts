import type { BackupStatus, InstanceStatus, NodeStatus, PowerAction } from "@gsm/shared";
import { POWER_ALLOWED } from "@gsm/shared";

export const NODE_STATUS_LABEL: Record<NodeStatus, string> = {
  online: "Online",
  offline: "Offline",
};

export const NODE_STATUS_DOT: Record<NodeStatus, string> = {
  online: "bg-status-online",
  offline: "bg-status-offline",
};

export const INSTANCE_STATUS_LABEL: Record<InstanceStatus, string> = {
  installing: "Installing",
  install_failed: "Install failed",
  stopped: "Stopped",
  starting: "Starting",
  running: "Running",
  stopping: "Stopping",
  crashed: "Crashed",
  unknown: "Unknown",
};

/** Dot colour per instance status. */
export const INSTANCE_STATUS_DOT: Record<InstanceStatus, string> = {
  installing: "bg-status-degraded",
  install_failed: "bg-status-critical",
  stopped: "bg-status-offline",
  starting: "bg-status-degraded",
  running: "bg-status-online",
  stopping: "bg-status-degraded",
  crashed: "bg-status-critical",
  unknown: "bg-status-offline",
};

/** Badge classes per instance status. */
export const INSTANCE_STATUS_STYLE: Record<InstanceStatus, string> = {
  installing: "border-status-degraded/40 bg-status-degraded/10 text-status-degraded",
  install_failed: "border-status-critical/40 bg-status-critical/10 text-status-critical",
  stopped: "border-border bg-muted text-muted-foreground",
  starting: "border-status-degraded/40 bg-status-degraded/10 text-status-degraded",
  running: "border-status-online/40 bg-status-online/10 text-status-online",
  stopping: "border-status-degraded/40 bg-status-degraded/10 text-status-degraded",
  crashed: "border-status-critical/40 bg-status-critical/10 text-status-critical",
  unknown: "border-border bg-muted text-muted-foreground",
};

/** Statuses that are in flux and should pulse. */
export const INSTANCE_STATUS_BUSY: ReadonlySet<InstanceStatus> = new Set([
  "installing",
  "starting",
  "stopping",
]);

export const BACKUP_STATUS_LABEL: Record<BackupStatus, string> = {
  pending: "Pending",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
};

export const BACKUP_STATUS_STYLE: Record<BackupStatus, string> = {
  pending: "border-border bg-muted text-muted-foreground",
  running: "border-status-degraded/40 bg-status-degraded/10 text-status-degraded",
  completed: "border-status-online/40 bg-status-online/10 text-status-online",
  failed: "border-status-critical/40 bg-status-critical/10 text-status-critical",
};

export function powerAllowed(status: InstanceStatus, action: PowerAction): boolean {
  return (POWER_ALLOWED[action] as readonly InstanceStatus[]).includes(status);
}

/** Console commands only make sense while the game process is up. */
export function commandAllowed(status: InstanceStatus): boolean {
  return status === "running" || status === "starting";
}
