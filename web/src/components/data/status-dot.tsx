import type { InstanceStatus, NodeStatus } from "@gsm/shared";
import {
  INSTANCE_STATUS_BUSY,
  INSTANCE_STATUS_DOT,
  INSTANCE_STATUS_LABEL,
  NODE_STATUS_DOT,
  NODE_STATUS_LABEL,
} from "@/lib/status";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

function Dot(
  { color, label, pulse, className }: {
    color: string;
    label: string;
    pulse: boolean;
    className?: string;
  },
) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn("relative inline-flex size-2 shrink-0", className)} aria-label={label}>
          {pulse && (
            <span
              className={cn(
                "absolute inline-flex size-full animate-ping rounded-full opacity-40",
                color,
              )}
            />
          )}
          <span className={cn("relative inline-flex size-2 rounded-full", color)} />
        </span>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export function StatusDot(
  { status, className, pulse = true }: {
    status: NodeStatus;
    className?: string;
    pulse?: boolean;
  },
) {
  return (
    <Dot
      color={NODE_STATUS_DOT[status]}
      label={NODE_STATUS_LABEL[status]}
      pulse={pulse && status === "online"}
      className={className}
    />
  );
}

export function InstanceDot(
  { status, className, pulse = true }: {
    status: InstanceStatus;
    className?: string;
    pulse?: boolean;
  },
) {
  return (
    <Dot
      color={INSTANCE_STATUS_DOT[status]}
      label={INSTANCE_STATUS_LABEL[status]}
      pulse={pulse && (status === "running" || INSTANCE_STATUS_BUSY.has(status))}
      className={className}
    />
  );
}

export function StatusLabel({ status, className }: { status: NodeStatus; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs", className)}>
      <StatusDot status={status} pulse={false} />
      {NODE_STATUS_LABEL[status]}
    </span>
  );
}
