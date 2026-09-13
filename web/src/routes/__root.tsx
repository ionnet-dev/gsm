import { createRootRouteWithContext, Outlet } from "@tanstack/react-router";
import type { RouterContext } from "@/app/router";
import { EmptyState } from "@/components/data/empty-state";
import { ErrorView } from "@/components/data/error-view";

export const Route = createRootRouteWithContext<RouterContext>()({
  component: () => <Outlet />,
  errorComponent: ({ error, reset }) => <ErrorView error={error} reset={reset} />,
  notFoundComponent: () => (
    <div className="flex h-screen items-center justify-center p-6">
      <EmptyState
        title="Page not found"
        description="The page you requested does not exist."
        className="w-full max-w-md"
      />
    </div>
  ),
});
