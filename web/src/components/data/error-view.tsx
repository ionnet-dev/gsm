import { Link, useRouter } from "@tanstack/react-router";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { ApiError } from "@/api/client";
import { Button } from "@/components/ui/button";

/** Route-level error UI. Keeps the shell usable and offers a retry. */
export function ErrorView({ error, reset }: { error: unknown; reset?: () => void }) {
  const router = useRouter();
  const message = error instanceof ApiError
    ? `${error.message} (${error.status})`
    : error instanceof Error
    ? error.message
    : String(error);
  const notFound = error instanceof ApiError && error.status === 404;
  return (
    <div className="flex h-full min-h-64 items-center justify-center p-6">
      <div className="w-full max-w-md rounded-lg border bg-card p-6 text-center">
        <AlertTriangle className="mx-auto size-8 text-status-degraded" />
        <div className="mt-3 text-sm font-medium">
          {notFound ? "Not found" : "Something went wrong"}
        </div>
        <p className="mt-1 break-words font-mono text-xs text-muted-foreground">{message}</p>
        <div className="mt-4 flex justify-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              reset?.();
              router.invalidate();
            }}
          >
            <RotateCcw /> Retry
          </Button>
          <Button size="sm" asChild>
            <Link to="/">Dashboard</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}

export function PendingView() {
  return (
    <div className="grid gap-3 p-6">
      <div className="h-6 w-48 animate-pulse rounded bg-muted" />
      <div className="h-4 w-80 animate-pulse rounded bg-muted" />
      <div className="mt-4 h-40 animate-pulse rounded-lg bg-muted/60" />
    </div>
  );
}
