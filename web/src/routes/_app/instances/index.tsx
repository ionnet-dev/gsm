import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { AlertTriangle, Boxes, Plus, Search } from "lucide-react";
import { z } from "zod";
import { INSTANCE_STATUSES, type InstanceStatus } from "@gsm/shared";
import { useInstances } from "@/api/instances";
import { useAllNodes, useManagesNodes } from "@/api/nodes";
import { useTemplates } from "@/api/templates";
import { CopyButton } from "@/components/data/copy-button";
import { EmptyState } from "@/components/data/empty-state";
import { MetricBar } from "@/components/data/metric-bar";
import { Pagination } from "@/components/data/pagination";
import { InstanceStatusBadge } from "@/components/data/status-badge";
import { InstanceDot } from "@/components/data/status-dot";
import { PowerButtons } from "@/components/instances/power-buttons";
import { hasReachabilityProblem } from "@/components/instances/reachability";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatBytes, pluralize } from "@/lib/format";
import { INSTANCE_STATUS_LABEL } from "@/lib/status";

const Search_ = z.object({
  page: z.number().int().min(1).optional(),
  status: z.enum(INSTANCE_STATUSES).optional(),
  nodeId: z.number().int().optional(),
  templateId: z.number().int().optional(),
  q: z.string().optional(),
});

export const Route = createFileRoute("/_app/instances/")({
  validateSearch: Search_,
  component: InstancesPage,
});

const PAGE_SIZE = 50;

function InstancesPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/instances/" });
  const managesNodes = useManagesNodes();
  const { data } = useInstances({ ...search, pageSize: PAGE_SIZE });
  const { data: nodes = [] } = useAllNodes(managesNodes);
  const { data: templates = [] } = useTemplates();
  const set = (patch: Partial<z.infer<typeof Search_>>) =>
    navigate({ search: (prev) => ({ ...prev, page: undefined, ...patch }) });

  return (
    <>
      <PageHeader
        title="Instances"
        description={data ? `${data.total} game server${data.total === 1 ? "" : "s"}` : undefined}
        actions={managesNodes && (
          <Button size="sm" asChild>
            <Link to="/instances/new">
              <Plus /> New instance
            </Link>
          </Button>
        )}
      />
      <div className="grid gap-3 p-4 sm:p-6">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search.q ?? ""}
              onChange={(e) => set({ q: e.target.value || undefined })}
              placeholder="Search…"
              className="w-56 pl-7"
            />
          </div>
          <Select
            value={search.status ?? "all"}
            onValueChange={(v) => set({ status: v === "all" ? undefined : v as InstanceStatus })}
          >
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Any status</SelectItem>
              {INSTANCE_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>{INSTANCE_STATUS_LABEL[s]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {managesNodes && (
            <Select
              value={search.nodeId ? String(search.nodeId) : "all"}
              onValueChange={(v) => set({ nodeId: v === "all" ? undefined : Number(v) })}
            >
              <SelectTrigger className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Any node</SelectItem>
                {nodes.map((n) => (
                  <SelectItem key={n.id} value={String(n.id)}>{n.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Select
            value={search.templateId ? String(search.templateId) : "all"}
            onValueChange={(v) => set({ templateId: v === "all" ? undefined : Number(v) })}
          >
            <SelectTrigger className="w-52">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Any template</SelectItem>
              {templates.map((t) => (
                <SelectItem key={t.id} value={String(t.id)}>{t.icon} {t.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="overflow-x-auto rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-6" />
                <TableHead>Name</TableHead>
                <TableHead>Status</TableHead>
                {managesNodes && <TableHead>Node</TableHead>}
                <TableHead>Address</TableHead>
                <TableHead>CPU</TableHead>
                <TableHead>Memory</TableHead>
                <TableHead className="w-36" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {data?.items.length === 0 && (
                <TableRow>
                  <TableCell colSpan={managesNodes ? 8 : 7} className="p-0">
                    <EmptyState
                      icon={Boxes}
                      title="No instances"
                      description={search.q || search.status
                        ? "Nothing matches these filters."
                        : managesNodes
                        ? "Create your first game server."
                        : "Nobody has shared an instance with you yet."}
                      className="border-0"
                    />
                  </TableCell>
                </TableRow>
              )}
              {data?.items.map((i) => {
                const s = i.status === "running" || i.status === "starting" ? i.lastStats : null;
                const memPct = s && s.memLimitBytes
                  ? (s.memUsedBytes / s.memLimitBytes) * 100
                  : null;
                return (
                  <TableRow key={i.id}>
                    <TableCell>
                      <InstanceDot status={i.status} />
                    </TableCell>
                    <TableCell>
                      <Link
                        to="/instances/$instanceId"
                        params={{ instanceId: String(i.id) }}
                        className="flex items-center gap-2 font-medium hover:underline"
                      >
                        <span className="text-base leading-none">{i.template.icon}</span>
                        {i.name}
                      </Link>
                      <div className="pl-6 text-xs text-muted-foreground">{i.template.name}</div>
                    </TableCell>
                    <TableCell>
                      <InstanceStatusBadge status={i.status} />
                      {i.players && i.status === "running" && (
                        <div className="mt-1 text-[11px] text-muted-foreground">
                          {pluralize(i.players.online, "player")} online
                        </div>
                      )}
                    </TableCell>
                    {managesNodes && (
                      <TableCell className="text-xs">
                        {nodes.some((n) => n.id === i.node.id)
                          ? (
                            <Link
                              to="/nodes/$nodeId"
                              params={{ nodeId: String(i.node.id) }}
                              className="hover:underline"
                            >
                              {i.node.name}
                            </Link>
                          )
                          : i.node.name}
                      </TableCell>
                    )}
                    <TableCell className="font-mono text-xs">
                      {i.address
                        ? (
                          <span className="inline-flex items-center gap-1">
                            {i.address} <CopyButton value={i.address} label="Copy address" />
                            {hasReachabilityProblem(i) && (
                              <span title="Not reachable from outside; see the instance">
                                <AlertTriangle className="size-3.5 text-status-degraded" />
                              </span>
                            )}
                          </span>
                        )
                        : <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell>
                      <MetricBar value={s ? Math.min(100, s.cpuPct) : null} />
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <MetricBar value={memPct} showLabel={false} />
                        <span className="font-mono text-[11px] text-muted-foreground">
                          {s ? formatBytes(s.memUsedBytes, 0) : "—"}
                          {i.limits.memoryMb > 0 &&
                            ` / ${formatBytes(i.limits.memoryMb * 1048576, 0)}`}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end">
                        <PowerButtons instance={i} compact />
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
        {data && (
          <Pagination
            page={data.page}
            pageSize={data.pageSize}
            total={data.total}
            onChange={(page) => navigate({ search: (prev) => ({ ...prev, page }) })}
          />
        )}
      </div>
    </>
  );
}
