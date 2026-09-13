import { createFileRoute, Link } from "@tanstack/react-router";
import { Boxes, Plus, Server } from "lucide-react";
import type { InstanceStatus } from "@gsm/shared";
import { useAuth } from "@/api/auth";
import { useInstances, useInstanceSummary } from "@/api/instances";
import { useAllNodes, useNodeSummary } from "@/api/nodes";
import { CopyButton } from "@/components/data/copy-button";
import { EmptyState } from "@/components/data/empty-state";
import { MetricBar } from "@/components/data/metric-bar";
import { InstanceStatusBadge } from "@/components/data/status-badge";
import { InstanceDot, StatusDot } from "@/components/data/status-dot";
import { PowerButtons } from "@/components/instances/power-buttons";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_app/")({ component: Dashboard });

const TILES: { status: InstanceStatus; label: string; tone: string }[] = [
  { status: "running", label: "Running", tone: "text-status-online" },
  { status: "stopped", label: "Stopped", tone: "text-muted-foreground" },
  { status: "crashed", label: "Crashed", tone: "text-status-critical" },
  { status: "installing", label: "Installing", tone: "text-status-degraded" },
];

function Dashboard() {
  const { admin } = useAuth();
  const { data: summary } = useInstanceSummary();
  const { data: nodes } = useNodeSummary(admin);
  const { data: instances } = useInstances({ pageSize: 50, sort: "status", dir: "desc" });
  const { data: nodeList = [] } = useAllNodes(admin);

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Your game servers at a glance."
        actions={admin && (
          <Button size="sm" asChild>
            <Link to="/instances/new">
              <Plus /> New instance
            </Link>
          </Button>
        )}
      />
      <div className="grid gap-4 p-4 sm:p-6">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
          <Tile label="Instances" value={summary?.total} />
          {TILES.map((t) => (
            <Tile
              key={t.status}
              label={t.label}
              value={summary?.byStatus[t.status]}
              tone={t.tone}
            />
          ))}
          {admin && (
            <Tile
              label="Nodes online"
              value={nodes ? `${nodes.online} / ${nodes.total}` : undefined}
              tone={nodes && nodes.offline > 0 ? "text-status-degraded" : "text-status-online"}
            />
          )}
        </div>

        {admin && nodeList.length > 0 && (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {nodeList.map((n) => {
              const m = n.lastMetrics;
              const memPct = m && m.memTotalBytes ? (m.memUsedBytes / m.memTotalBytes) * 100 : null;
              const allocPct = n.memoryTotal
                ? (n.allocatedMemoryMb * 1024 * 1024 / n.memoryTotal) * 100
                : null;
              return (
                <Card key={n.id}>
                  <CardHeader className="pb-1">
                    <CardTitle className="flex items-center gap-2 normal-case tracking-normal">
                      <StatusDot status={n.status} />
                      <Link
                        to="/nodes/$nodeId"
                        params={{ nodeId: String(n.id) }}
                        className="text-[13px] font-semibold text-foreground hover:underline"
                      >
                        {n.name}
                      </Link>
                      <span className="ml-auto font-mono text-[11px] text-muted-foreground">
                        {n.runningCount}/{n.instanceCount} running
                      </span>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="grid gap-1.5 text-xs">
                    <Row label="CPU">
                      <MetricBar value={n.status === "online" ? m?.cpuPct : null} />
                    </Row>
                    <Row label="Memory">
                      <MetricBar value={n.status === "online" ? memPct : null} />
                    </Row>
                    <Row label="Allocated">
                      <span className="font-mono">
                        {formatBytes(n.allocatedMemoryMb * 1024 * 1024, 0)}
                        {allocPct !== null && (
                          <span
                            className={cn(
                              "text-muted-foreground",
                              allocPct > 100 && "text-status-critical",
                            )}
                          >
                            {" "}({Math.round(allocPct)}%)
                          </span>
                        )}
                      </span>
                    </Row>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}

        <div className="rounded-lg border bg-card">
          <div className="flex items-center justify-between border-b px-4 py-2.5">
            <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Instances
            </div>
            <Button size="sm" variant="ghost" asChild>
              <Link to="/instances">View all</Link>
            </Button>
          </div>
          {instances && instances.items.length === 0 && (
            <EmptyState
              icon={Boxes}
              title="No instances yet"
              description={admin
                ? "Enroll a node, then create your first game server."
                : "Nobody has shared an instance with you yet."}
              className="border-0"
              action={admin && (
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" asChild>
                    <Link to="/settings/enrollment">
                      <Server /> Add a node
                    </Link>
                  </Button>
                  <Button size="sm" asChild>
                    <Link to="/instances/new">
                      <Plus /> New instance
                    </Link>
                  </Button>
                </div>
              )}
            />
          )}
          <ul className="divide-y">
            {instances?.items.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
                <InstanceDot status={i.status} />
                <span className="text-base leading-none">{i.template.icon}</span>
                <Link
                  to="/instances/$instanceId"
                  params={{ instanceId: String(i.id) }}
                  className="min-w-0 flex-1 truncate font-medium hover:underline"
                >
                  {i.name}
                </Link>
                <InstanceStatusBadge status={i.status} />
                {i.address && (
                  <span className="hidden items-center gap-1 font-mono text-xs text-muted-foreground sm:flex">
                    {i.address} <CopyButton value={i.address} label="Copy address" />
                  </span>
                )}
                <PowerButtons instance={i} compact />
              </li>
            ))}
          </ul>
        </div>
      </div>
    </>
  );
}

function Tile(
  { label, value, tone }: { label: string; value: number | string | undefined; tone?: string },
) {
  return (
    <div className="rounded-lg border bg-card px-4 py-3">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={cn("mt-1 font-mono text-2xl tabular-nums", tone)}>{value ?? "—"}</div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-16 text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}
