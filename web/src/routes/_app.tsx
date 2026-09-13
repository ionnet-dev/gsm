import { createFileRoute, Outlet, redirect, useLocation } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { authStatusQuery } from "@/api/auth";
import { fileKeys, uploads } from "@/api/files";
import { Sidebar } from "@/components/layout/sidebar";
import { Topbar } from "@/components/layout/topbar";
import { uiSocket } from "@/ws/ui-socket";
import { CommandPalette } from "@/components/layout/command-palette";
import { UploadTray } from "@/components/files/upload-tray";
import { ShortcutsHelp, useShortcuts } from "@/components/layout/shortcuts";
import { ErrorView, PendingView } from "@/components/data/error-view";
import { PaletteContext } from "@/components/layout/palette-context";

export const Route = createFileRoute("/_app")({
  beforeLoad: async ({ context, location }) => {
    const status = await context.queryClient.ensureQueryData(authStatusQuery);
    if (status.setupRequired) throw redirect({ to: "/setup" });
    if (!status.user) throw redirect({ to: "/login", search: { redirect: location.href } });
    return { user: status.user };
  },
  component: AppLayout,
  errorComponent: ({ error, reset }) => <ErrorView error={error} reset={reset} />,
  pendingComponent: PendingView,
});

function AppLayout() {
  const qc = useQueryClient();
  useEffect(() => {
    uiSocket.start(qc);
    return () => uiSocket.stop();
  }, [qc]);
  useEffect(() => {
    uploads.onFinished = (instanceId) =>
      qc.invalidateQueries({ queryKey: [...fileKeys.all(instanceId), "dir"] });
    return () => {
      uploads.onFinished = null;
    };
  }, [qc]);
  const [palette, setPalette] = useState(false);
  // Mobile navigation drawer; closes on every route change.
  const [navOpen, setNavOpen] = useState(false);
  const { pathname } = useLocation();
  useEffect(() => setNavOpen(false), [pathname]);
  const openPalette = useCallback(() => setPalette((p) => !p), []);
  const { help, setHelp } = useShortcuts({ onPalette: openPalette });

  return (
    <PaletteContext.Provider value={{ open: () => setPalette(true) }}>
      <div className="flex h-dvh w-full overflow-hidden bg-background">
        <Sidebar open={navOpen} onClose={() => setNavOpen(false)} />
        <div className="flex min-w-0 flex-1 flex-col">
          <Topbar onMenu={() => setNavOpen(true)} />
          <main className="scrollbar-thin flex-1 overflow-x-hidden overflow-y-auto">
            <Outlet />
          </main>
        </div>
      </div>
      <CommandPalette open={palette} onOpenChange={setPalette} />
      <ShortcutsHelp open={help} onOpenChange={setHelp} />
      <UploadTray />
    </PaletteContext.Provider>
  );
}
