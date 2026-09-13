import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Kbd } from "@/components/data/kbd";

const GO: Record<string, string> = {
  d: "/",
  i: "/instances",
  n: "/nodes",
  t: "/templates",
  s: "/settings",
};

function isTyping(e: KeyboardEvent) {
  const t = e.target;
  if (!(t instanceof HTMLElement)) return false;
  return t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable ||
    !!t.closest(".xterm");
}

/** Global shortcuts: ⌘K palette, "g <letter>" navigation, "?" help. */
export function useShortcuts({ onPalette }: { onPalette: () => void }) {
  const navigate = useNavigate();
  const [help, setHelp] = useState(false);
  useEffect(() => {
    let pendingG = 0;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        onPalette();
        return;
      }
      if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "?") {
        setHelp((h) => !h);
        return;
      }
      if (e.key === "g") {
        pendingG = Date.now();
        return;
      }
      if (pendingG && Date.now() - pendingG < 1200 && GO[e.key]) {
        pendingG = 0;
        navigate({ to: GO[e.key] });
      } else {
        pendingG = 0;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate, onPalette]);
  return { help, setHelp };
}

export function ShortcutsHelp(
  { open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void },
) {
  const rows: [string, string][] = [
    ["⌘ K / Ctrl K", "Command palette"],
    ["g d", "Dashboard"],
    ["g i", "Instances"],
    ["g n", "Nodes"],
    ["g t", "Templates"],
    ["g s", "Settings"],
    ["?", "This help"],
  ];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Shortcuts are ignored while typing in a field or the console.
          </DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-[13px]">
          {rows.map(([k, v]) => (
            <div key={k} className="contents">
              <dt>
                {k.split(" / ").map((part, i) => (
                  <span key={part}>
                    {i > 0 && <span className="text-muted-foreground">/</span>}
                    {part.split(" ").map((key) => (
                      <Kbd key={key} className="mr-1 text-[11px]">
                        {key}
                      </Kbd>
                    ))}
                  </span>
                ))}
              </dt>
              <dd className="text-muted-foreground">{v}</dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  );
}
