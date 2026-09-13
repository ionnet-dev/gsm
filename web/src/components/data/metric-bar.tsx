import { cn } from "@/lib/utils";

/** Compact horizontal usage bar. Colour shifts as usage approaches 100%. */
export function MetricBar(
  { value, className, showLabel = true }: {
    value: number | null | undefined;
    className?: string;
    showLabel?: boolean;
  },
) {
  const pct = value === null || value === undefined || !Number.isFinite(value)
    ? null
    : Math.max(0, Math.min(100, value));
  const tone = pct === null
    ? "bg-muted"
    : pct >= 90
    ? "bg-status-critical"
    : pct >= 75
    ? "bg-status-degraded"
    : "bg-primary";
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
        {pct !== null && (
          <div
            className={cn("h-full rounded-full transition-[width]", tone)}
            style={{ width: `${pct}%` }}
          />
        )}
      </div>
      {showLabel && (
        <span className="w-9 text-right font-mono text-[11px] tabular-nums text-muted-foreground">
          {pct === null ? "—" : `${Math.round(pct)}%`}
        </span>
      )}
    </div>
  );
}
