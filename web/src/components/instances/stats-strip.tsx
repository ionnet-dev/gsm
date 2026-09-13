import type { InstanceDto } from "@gsm/shared";
import { MetricBar } from "@/components/data/metric-bar";
import { formatBytes, formatUptime, pluralize } from "@/lib/format";
import { cn } from "@/lib/utils";

/** CPU, memory, uptime and network for one instance, from its latest stats sample. */
export function StatsStrip({ instance }: { instance: InstanceDto }) {
  const s = instance.status === "running" || instance.status === "starting"
    ? instance.lastStats
    : null;
  const memPct = s && s.memLimitBytes > 0 ? (s.memUsedBytes / s.memLimitBytes) * 100 : null;
  return (
    <div
      className={cn(
        "grid grid-cols-2 gap-3 rounded-lg border bg-card px-4 py-3 text-xs sm:grid-cols-4",
        instance.players ? "lg:grid-cols-7" : "lg:grid-cols-6",
      )}
    >
      <Stat label="CPU">
        <MetricBar value={s ? Math.min(100, s.cpuPct) : null} />
      </Stat>
      <Stat label="Memory">
        {s
          ? (
            <div className="flex items-center gap-2">
              <MetricBar value={memPct} showLabel={false} />
              <span className="font-mono tabular-nums">
                {formatBytes(s.memUsedBytes)}
                {s.memLimitBytes > 0 && (
                  <span className="text-muted-foreground">/ {formatBytes(s.memLimitBytes)}</span>
                )}
              </span>
            </div>
          )
          : <span className="text-muted-foreground">—</span>}
      </Stat>
      <Stat label="Uptime">
        <span className="font-mono">{s ? formatUptime(s.uptimeSeconds) : "—"}</span>
      </Stat>
      {instance.players && (
        <Stat label="Players">
          <span className="font-mono">
            {s ? `${pluralize(instance.players.online, "player")} online` : "—"}
          </span>
        </Stat>
      )}
      <Stat label="Network">
        <span className="font-mono">
          {s ? `↓ ${formatBytes(s.netRxBytes, 0)} ↑ ${formatBytes(s.netTxBytes, 0)}` : "—"}
        </span>
      </Stat>
      <Stat label="Disk">
        <span className="font-mono">
          {instance.lastStats?.diskUsedBytes ? formatBytes(instance.lastStats.diskUsedBytes) : "—"}
          {instance.limits.diskMb > 0 && (
            <span className="text-muted-foreground">/ {instance.limits.diskMb} MB</span>
          )}
        </span>
      </Stat>
      <Stat label="Address">
        <span className="font-mono">{instance.address ?? "—"}</span>
      </Stat>
    </div>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-0.5 truncate">{children}</div>
    </div>
  );
}
