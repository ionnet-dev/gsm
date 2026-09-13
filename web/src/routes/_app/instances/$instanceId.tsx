import { createFileRoute, Link, Outlet } from "@tanstack/react-router";
import { AlertTriangle, Server } from "lucide-react";
import { roleAllows } from "@gsm/shared";
import { useAuth } from "@/api/auth";
import { useInstance } from "@/api/instances";
import { CopyButton } from "@/components/data/copy-button";
import { ErrorView, PendingView } from "@/components/data/error-view";
import { InstanceStatusBadge } from "@/components/data/status-badge";
import { PowerButtons } from "@/components/instances/power-buttons";
import { StatsStrip } from "@/components/instances/stats-strip";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_app/instances/$instanceId")({
  component: InstanceLayout,
  errorComponent: ({ error, reset }) => <ErrorView error={error} reset={reset} />,
});

function InstanceLayout() {
  const instanceId = Number(Route.useParams().instanceId);
  const { admin } = useAuth();
  const q = useInstance(instanceId);
  if (q.isLoading) return <PendingView />;
  if (q.error) return <ErrorView error={q.error} reset={() => q.refetch()} />;
  const i = q.data!;
  const tabs = [
    { to: "/instances/$instanceId", label: "Console", exact: true, show: true },
    {
      to: "/instances/$instanceId/players",
      label: "Players",
      show: !!i.players,
      count: i.status === "running" ? i.players?.online : 0,
    },
    { to: "/instances/$instanceId/files", label: "Files", show: roleAllows(i.myRole, "files") },
    {
      to: "/instances/$instanceId/backups",
      label: "Backups",
      show: roleAllows(i.myRole, "backups"),
    },
    { to: "/instances/$instanceId/settings", label: "Settings", show: true },
    { to: "/instances/$instanceId/access", label: "Access", show: roleAllows(i.myRole, "access") },
    { to: "/instances/$instanceId/activity", label: "Activity", show: true },
  ].filter((t) => t.show);

  return (
    <>
      <div className="border-b px-4 py-3 sm:px-6 sm:py-4">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xl leading-none">{i.template.icon}</span>
              <h1 className="text-lg font-semibold tracking-tight">{i.name}</h1>
              <InstanceStatusBadge status={i.status} />
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span>{i.template.name}</span>
              {admin && (
                <Link
                  to="/nodes/$nodeId"
                  params={{ nodeId: String(i.node.id) }}
                  className="inline-flex items-center gap-1 hover:underline"
                >
                  <Server className="size-3" /> {i.node.name}
                </Link>
              )}
              {i.address && (
                <span className="inline-flex items-center gap-1 font-mono">
                  {i.address} <CopyButton value={i.address} label="Copy address" />
                </span>
              )}
            </div>
          </div>
          <PowerButtons instance={i} />
        </div>
        {i.error && (
          <div className="mt-3 flex items-start gap-2 rounded-md border border-status-critical/40 bg-status-critical/10 px-3 py-2 text-xs">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-status-critical" />
            <span className="break-words">{i.error}</span>
          </div>
        )}
        {i.node.status === "offline" && (
          <div className="mt-3 rounded-md border border-status-degraded/40 bg-status-degraded/10 px-3 py-2 text-xs">
            The node hosting this instance is offline; nothing can be done until it reconnects.
          </div>
        )}
        <nav className="scrollbar-none -mx-4 mt-3 flex gap-1 overflow-x-auto px-4 sm:-mx-6 sm:px-6">
          {tabs.map((t) => (
            <Link
              key={t.to}
              to={t.to}
              params={{ instanceId: String(instanceId) }}
              activeOptions={{ exact: t.exact ?? false }}
              className={cn(
                "shrink-0 rounded-md px-2.5 py-1.5 text-[13px] text-muted-foreground hover:bg-accent hover:text-foreground",
                "data-[status=active]:bg-accent data-[status=active]:font-medium data-[status=active]:text-foreground",
              )}
            >
              {t.label}
              {t.count
                ? (
                  <span className="ml-1.5 rounded bg-status-online/15 px-1 text-[11px] text-status-online tabular-nums">
                    {t.count}
                  </span>
                )
                : null}
            </Link>
          ))}
        </nav>
      </div>
      <div className="grid gap-4 p-4 sm:p-6">
        <StatsStrip instance={i} />
        <Outlet />
      </div>
    </>
  );
}
