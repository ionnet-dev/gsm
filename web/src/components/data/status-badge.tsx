import type { BackupStatus, InstanceStatus } from "@gsm/shared";
import { Loader2 } from "lucide-react";
import {
  BACKUP_STATUS_LABEL,
  BACKUP_STATUS_STYLE,
  INSTANCE_STATUS_BUSY,
  INSTANCE_STATUS_LABEL,
  INSTANCE_STATUS_STYLE,
} from "@/lib/status";
import { cn } from "@/lib/utils";

export function InstanceStatusBadge(
  { status, className }: { status: InstanceStatus; className?: string },
) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] font-medium",
        INSTANCE_STATUS_STYLE[status],
        className,
      )}
    >
      {INSTANCE_STATUS_BUSY.has(status) && <Loader2 className="size-3 animate-spin" />}
      {INSTANCE_STATUS_LABEL[status]}
    </span>
  );
}

export function BackupStatusBadge(
  { status, className }: { status: BackupStatus; className?: string },
) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] font-medium",
        BACKUP_STATUS_STYLE[status],
        className,
      )}
    >
      {status === "running" && <Loader2 className="size-3 animate-spin" />}
      {BACKUP_STATUS_LABEL[status]}
    </span>
  );
}
