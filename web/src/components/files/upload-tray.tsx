import { useEffect } from "react";
import { CheckCircle2, Loader2, Upload, X, XCircle } from "lucide-react";
import { type UploadItem, uploads, useUploads } from "@/api/files";
import { Button } from "@/components/ui/button";
import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Uploads in progress (and just finished) for this page, bottom right. They keep going while the
 * operator browses elsewhere in the app; closing the tab cancels them.
 */
export function UploadTray() {
  const items = useUploads();
  const active = items.filter((u) => u.state === "uploading").length;

  // Finished uploads go away on their own after a while; failures stay until dismissed.
  useEffect(() => {
    const done = items.filter((u) => u.state === "done" || u.state === "cancelled");
    if (!done.length) return;
    const t = setTimeout(() => done.forEach((u) => uploads.dismiss(u.id)), 6000);
    return () => clearTimeout(t);
  }, [items]);

  useEffect(() => {
    if (!active) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    addEventListener("beforeunload", warn);
    return () => removeEventListener("beforeunload", warn);
  }, [active]);

  if (!items.length) return null;
  return (
    <div className="fixed right-4 bottom-4 z-40 w-[min(24rem,calc(100vw-2rem))] overflow-hidden rounded-lg border bg-popover shadow-2xl">
      <div className="flex items-center gap-2 border-b px-3 py-2 text-xs font-medium">
        <Upload className="size-3.5" />
        <span className="flex-1">
          {active ? `Uploading ${active} of ${items.length}` : "Uploads"}
        </span>
        {items.length > active && (
          <Button
            size="sm"
            variant="ghost"
            className="h-6"
            onClick={() => uploads.clearFinished()}
          >
            Clear
          </Button>
        )}
      </div>
      <ul className="max-h-72 overflow-auto">
        {items.map((u) => <UploadRow key={u.id} u={u} />)}
      </ul>
    </div>
  );
}

function UploadRow({ u }: { u: UploadItem }) {
  const pct = u.size ? Math.min(100, (u.loaded / u.size) * 100) : 100;
  return (
    <li className="border-b px-3 py-2 last:border-0">
      <div className="flex items-center gap-2 text-xs">
        {u.state === "uploading" && <Loader2 className="size-3.5 shrink-0 animate-spin" />}
        {u.state === "done" && <CheckCircle2 className="size-3.5 shrink-0 text-status-online" />}
        {(u.state === "failed" || u.state === "cancelled") && (
          <XCircle
            className={cn(
              "size-3.5 shrink-0",
              u.state === "failed" ? "text-status-critical" : "text-muted-foreground",
            )}
          />
        )}
        <span className="min-w-0 flex-1 truncate font-mono" title={u.path}>{u.name}</span>
        <span className="shrink-0 text-muted-foreground">
          {u.state === "uploading"
            ? u.placing ? "verifying…" : `${formatBytes(u.loaded)} / ${formatBytes(u.size)}`
            : u.state === "done"
            ? formatBytes(u.size)
            : u.state}
        </span>
        <Button
          size="icon-sm"
          variant="ghost"
          className="size-5"
          aria-label={u.state === "uploading" ? "Cancel upload" : "Dismiss"}
          onClick={() => (u.state === "uploading" ? uploads.cancel(u.id) : uploads.dismiss(u.id))}
        >
          <X className="size-3" />
        </Button>
      </div>
      {u.state === "uploading" && (
        <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted">
          <div
            className={cn("h-full bg-primary transition-[width]", u.placing && "animate-pulse")}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
      {u.error && <div className="mt-1 text-xs text-status-critical">{u.error}</div>}
    </li>
  );
}
