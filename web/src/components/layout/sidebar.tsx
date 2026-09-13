import { Link } from "@tanstack/react-router";
import {
  Boxes,
  LayoutDashboard,
  LayoutTemplate,
  type LucideIcon,
  Server,
  Settings,
  X,
} from "lucide-react";
import { useEffect } from "react";
import { useAuth } from "@/api/auth";
import { useInstanceSummary } from "@/api/instances";
import { useManagesNodes, useNodeSummary } from "@/api/nodes";
import { useHealth } from "@/api/system";
import { cn } from "@/lib/utils";
import { GsmMark } from "./gsm-mark";

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  count?: number;
  exact?: boolean;
}

/**
 * Persistent on large screens; below `lg` it is an off-canvas drawer opened from the topbar.
 */
export function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  const { admin } = useAuth();
  const managesNodes = useManagesNodes();
  const { data: instances } = useInstanceSummary();
  const { data: nodes } = useNodeSummary();
  const { data: health } = useHealth();
  const NAV: (NavItem | { section: string })[] = [
    { to: "/", label: "Dashboard", icon: LayoutDashboard, exact: true },
    { section: "Servers" },
    { to: "/instances", label: "Instances", icon: Boxes, count: instances?.total },
    ...(managesNodes ? [{ to: "/nodes", label: "Nodes", icon: Server, count: nodes?.total }] : []),
    ...(admin ? [{ to: "/templates", label: "Templates", icon: LayoutTemplate }] : []),
    { section: "System" },
    { to: "/settings", label: "Settings", icon: Settings },
  ];

  return (
    <>
      {open && (
        <div
          className="fixed inset-0 z-30 bg-black/60 backdrop-blur-[1px] lg:hidden"
          onClick={onClose}
          aria-hidden
        />
      )}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-40 flex w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-transform duration-200",
          "lg:static lg:w-56 lg:translate-x-0 lg:transition-none",
          open ? "translate-x-0 shadow-2xl" : "-translate-x-full",
        )}
        aria-label="Main navigation"
      >
        <div className="flex h-12 items-center border-b border-sidebar-border pr-2 pl-4">
          <Link to="/" className="flex min-w-0 flex-1 items-center gap-2.5">
            <GsmMark className="size-6" />
            <span className="text-sm font-semibold tracking-tight text-foreground">
              Ionnet GSM
            </span>
          </Link>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close menu"
            className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground lg:hidden"
          >
            <X className="size-4" />
          </button>
        </div>
        <nav className="scrollbar-thin flex-1 overflow-y-auto px-2 py-3">
          {NAV.map((item, i) =>
            "section" in item
              ? (
                <div
                  key={i}
                  className="mt-4 mb-1 px-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70 first:mt-0"
                >
                  {item.section}
                </div>
              )
              : (
                <Link
                  key={item.to}
                  to={item.to}
                  activeOptions={{ exact: item.exact ?? false }}
                  onClick={onClose}
                  className={cn(
                    "flex h-9 items-center gap-2.5 rounded-md px-2 text-[13px] hover:bg-accent hover:text-accent-foreground lg:h-8",
                    "data-[status=active]:bg-accent data-[status=active]:font-medium data-[status=active]:text-foreground",
                  )}
                >
                  <item.icon className="size-4 shrink-0 opacity-80" />
                  <span className="flex-1 truncate">{item.label}</span>
                  {item.count !== undefined && (
                    <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                      {item.count}
                    </span>
                  )}
                </Link>
              )
          )}
        </nav>
        <div className="flex items-center justify-between border-t border-sidebar-border px-4 py-2 text-[11px] text-muted-foreground">
          <span>v{health?.version ?? "…"}</span>
          <kbd
            className="rounded border bg-muted px-1 font-mono text-[10px]"
            title="Keyboard shortcuts"
          >
            ?
          </kbd>
        </div>
      </aside>
    </>
  );
}
