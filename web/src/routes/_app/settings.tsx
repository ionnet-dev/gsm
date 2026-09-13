import { createFileRoute, Link, Outlet } from "@tanstack/react-router";
import { useAuth } from "@/api/auth";
import { PageHeader } from "@/components/layout/page-header";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_app/settings")({
  component: SettingsLayout,
});

function SettingsLayout() {
  const { user } = useAuth();
  const admin = user?.role === "admin";
  const items = [
    { to: "/settings", label: "General", exact: true },
    { to: "/settings/account", label: "My account" },
    ...(admin
      ? [
        { to: "/settings/users", label: "Users & roles" },
        { to: "/settings/enrollment", label: "Enrollment" },
        { to: "/settings/agent-releases", label: "Agent releases" },
        { to: "/settings/audit", label: "Audit log" },
      ]
      : []),
  ];
  return (
    <>
      <PageHeader title="Settings" />
      <div className="grid gap-4 p-4 sm:p-6 md:grid-cols-[12rem_1fr] md:gap-6">
        <nav className="scrollbar-none -mx-4 flex gap-0.5 overflow-x-auto px-4 sm:-mx-6 sm:px-6 md:mx-0 md:grid md:content-start md:px-0">
          {items.map((i) => (
            <Link
              key={i.to}
              to={i.to}
              activeOptions={{ exact: i.exact }}
              className={cn(
                "shrink-0 whitespace-nowrap rounded-md px-2.5 py-1.5 text-[13px] text-muted-foreground hover:bg-accent hover:text-foreground",
                "data-[status=active]:bg-accent data-[status=active]:font-medium data-[status=active]:text-foreground",
              )}
            >
              {i.label}
            </Link>
          ))}
        </nav>
        <div className="min-w-0">
          <Outlet />
        </div>
      </div>
    </>
  );
}
