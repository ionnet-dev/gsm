import { createFileRoute, Link, redirect, useNavigate } from "@tanstack/react-router";
import { Plus, Search, Server } from "lucide-react";
import { z } from "zod";
import { useAuth } from "@/api/auth";
import { managesNodes, useNodes } from "@/api/nodes";
import { EmptyState } from "@/components/data/empty-state";
import { MetricBar } from "@/components/data/metric-bar";
import { Pagination } from "@/components/data/pagination";
import { StatusDot } from "@/components/data/status-dot";
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
import { formatBytes, formatRelative } from "@/lib/format";

const Search_ = z.object({
  page: z.number().int().min(1).optional(),
  status: z.enum(["online", "offline"]).optional(),
  q: z.string().optional(),
});

export const Route = createFileRoute("/_app/nodes/")({
  validateSearch: Search_,
  beforeLoad: async ({ context }) => {
    if (!(await managesNodes(context.queryClient))) throw redirect({ to: "/" });
  },
  component: NodesPage,
});

function NodesPage() {
  const search = Route.useSearch();
  const { admin } = useAuth();
  const navigate = useNavigate({ from: "/nodes/" });
  const { data } = useNodes({ ...search, pageSize: 50 });
  const set = (patch: Partial<z.infer<typeof Search_>>) =>
    navigate({ search: (prev) => ({ ...prev, page: undefined, ...patch }) });
  return (
    <>
      <PageHeader
        title="Nodes"
        description={admin
          ? "Machines running the agent and hosting instances."
          : "The machines you own, with every instance on them."}
        actions={admin && (
          <Button size="sm" asChild>
            <Link to="/settings/enrollment">
              <Plus /> Add node
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
            onValueChange={(v) =>
              set({ status: v === "all" ? undefined : v as "online" | "offline" })}
          >
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Any status</SelectItem>
              <SelectItem value="online">Online</SelectItem>
              <SelectItem value="offline">Offline</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="overflow-x-auto rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-6" />
                <TableHead>Node</TableHead>
                <TableHead>OS</TableHead>
                <TableHead>Agent</TableHead>
                <TableHead>Instances</TableHead>
                {admin && <TableHead>Owners</TableHead>}
                <TableHead>CPU</TableHead>
                <TableHead>Memory</TableHead>
                <TableHead>Data</TableHead>
                <TableHead>Last seen</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data?.items.length === 0 && (
                <TableRow>
                  <TableCell colSpan={admin ? 10 : 9} className="p-0">
                    <EmptyState
                      icon={Server}
                      title="No nodes"
                      description="Create an enrollment token and run the install script on a machine."
                      className="border-0"
                      action={admin && (
                        <Button size="sm" asChild>
                          <Link to="/settings/enrollment">Add node</Link>
                        </Button>
                      )}
                    />
                  </TableCell>
                </TableRow>
              )}
              {data?.items.map((n) => {
                const m = n.status === "online" ? n.lastMetrics : null;
                const memPct = m && m.memTotalBytes
                  ? (m.memUsedBytes / m.memTotalBytes) * 100
                  : null;
                return (
                  <TableRow key={n.id}>
                    <TableCell>
                      <StatusDot status={n.status} />
                    </TableCell>
                    <TableCell>
                      <Link
                        to="/nodes/$nodeId"
                        params={{ nodeId: String(n.id) }}
                        className="font-medium hover:underline"
                      >
                        {n.name}
                      </Link>
                      <div className="font-mono text-xs text-muted-foreground">{n.hostname}</div>
                    </TableCell>
                    <TableCell className="text-xs">{n.os.prettyName ?? "—"}</TableCell>
                    <TableCell className="font-mono text-xs">{n.agentVersion ?? "—"}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {n.runningCount} / {n.instanceCount}
                    </TableCell>
                    {admin && (
                      <TableCell className="text-xs">
                        {n.owners.length
                          ? n.owners.map((o) => o.name).join(", ")
                          : <span className="text-muted-foreground">—</span>}
                      </TableCell>
                    )}
                    <TableCell>
                      <MetricBar value={m?.cpuPct} />
                    </TableCell>
                    <TableCell>
                      <MetricBar value={memPct} />
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {m ? formatBytes(m.dataUsedBytes, 0) : "—"}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatRelative(n.lastSeenAt)}
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
