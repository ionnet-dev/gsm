import { useNavigate } from "@tanstack/react-router";
import {
  Boxes,
  KeySquare,
  LayoutDashboard,
  LayoutTemplate,
  Plus,
  Server,
  Settings,
  TerminalSquare,
  Users,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@/api/auth";
import { useInstances } from "@/api/instances";
import { useManagesNodes } from "@/api/nodes";
import { InstanceDot } from "@/components/data/status-dot";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";

/** ⌘K / Ctrl+K palette: jump to pages and instances. */
export function CommandPalette(
  { open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void },
) {
  const navigate = useNavigate();
  const { admin } = useAuth();
  const managesNodes = useManagesNodes();
  const [q, setQ] = useState("");
  const { data: instances } = useInstances({ q: q.length >= 1 ? q : undefined, pageSize: 8 });

  useEffect(() => {
    if (!open) setQ("");
  }, [open]);

  const go = (fn: () => void) => () => {
    onOpenChange(false);
    fn();
  };

  const pages = useMemo(
    () => [
      { label: "Dashboard", icon: LayoutDashboard, to: "/", keys: "g d" },
      { label: "Instances", icon: Boxes, to: "/instances", keys: "g i" },
      ...(managesNodes
        ? [
          { label: "New instance", icon: Plus, to: "/instances/new" },
          { label: "Nodes", icon: Server, to: "/nodes", keys: "g n" },
        ]
        : []),
      ...(admin
        ? [
          { label: "Templates", icon: LayoutTemplate, to: "/templates", keys: "g t" },
          { label: "Users & roles", icon: Users, to: "/settings/users" },
          { label: "Enrollment tokens", icon: KeySquare, to: "/settings/enrollment" },
        ]
        : []),
      { label: "Settings", icon: Settings, to: "/settings", keys: "g s" },
    ],
    [admin, managesNodes],
  );

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder="Search instances, pages…" value={q} onValueChange={setQ} />
      <CommandList>
        <CommandEmpty>Nothing matches.</CommandEmpty>
        {instances && instances.items.length > 0 && (
          <CommandGroup heading="Instances">
            {instances.items.map((i) => (
              <CommandItem
                key={i.id}
                value={`instance ${i.name} ${i.template.game}`}
                onSelect={go(() =>
                  navigate({ to: "/instances/$instanceId", params: { instanceId: String(i.id) } })
                )}
              >
                <InstanceDot status={i.status} pulse={false} />
                <span>{i.template.icon}</span>
                <span>{i.name}</span>
                <span className="text-xs text-muted-foreground">{i.template.name}</span>
                <button
                  className="ml-auto inline-flex items-center gap-1 rounded border px-1.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
                  onClick={(e) => {
                    e.stopPropagation();
                    go(() =>
                      navigate({
                        to: "/instances/$instanceId",
                        params: { instanceId: String(i.id) },
                      })
                    )();
                  }}
                >
                  <TerminalSquare className="size-3" /> console
                </button>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        <CommandGroup heading="Go to">
          {pages.map((p) => (
            <CommandItem
              key={p.to}
              value={`page ${p.label}`}
              onSelect={go(() => navigate({ to: p.to }))}
            >
              <p.icon /> {p.label}
              {p.keys && <CommandShortcut>{p.keys}</CommandShortcut>}
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
