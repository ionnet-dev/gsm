import { useNavigate } from "@tanstack/react-router";
import { LogOut, Menu, Moon, Search, Sun, User, Wifi, WifiOff } from "lucide-react";
import { GsmMark } from "./gsm-mark";
import { useEffect, useState } from "react";
import { useAuth, useLogout } from "@/api/auth";
import { useTheme } from "@/app/theme";
import { Kbd } from "@/components/data/kbd";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { uiSocket } from "@/ws/ui-socket";
import { usePalette } from "./palette-context";
import { cn } from "@/lib/utils";

export function Topbar({ onMenu }: { onMenu: () => void }) {
  const { user } = useAuth();
  const logout = useLogout();
  const navigate = useNavigate();
  const { theme, toggle } = useTheme();
  const palette = usePalette();
  const [connected, setConnected] = useState(uiSocket.connected);
  useEffect(() => uiSocket.onStatus(setConnected), []);

  const initials = (user?.name ?? "?")
    .split(/\s+/)
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return (
    <header className="flex h-12 shrink-0 items-center gap-1.5 border-b bg-background/80 px-2 backdrop-blur sm:gap-2 sm:px-4">
      <Button
        variant="ghost"
        size="icon"
        aria-label="Open menu"
        className="lg:hidden"
        onClick={onMenu}
      >
        <Menu />
      </Button>
      <GsmMark className="size-6 lg:hidden" />
      <Button
        variant="outline"
        size="sm"
        className="hidden w-72 justify-start gap-2 text-muted-foreground md:flex"
        onClick={palette.open}
      >
        <Search className="size-3.5" />
        <span className="flex-1 text-left text-xs">Search instances, pages…</span>
        <Kbd>⌘K</Kbd>
      </Button>
      <div className="flex-1" />
      <Button
        variant="ghost"
        size="icon"
        aria-label="Search"
        className="md:hidden"
        onClick={palette.open}
      >
        <Search />
      </Button>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={cn(
              "hidden sm:inline-flex",
              connected ? "text-status-online" : "text-status-critical",
            )}
          >
            {connected ? <Wifi className="size-4" /> : <WifiOff className="size-4" />}
          </span>
        </TooltipTrigger>
        <TooltipContent>
          {connected ? "Live updates connected" : "Live updates disconnected — reconnecting"}
        </TooltipContent>
      </Tooltip>
      <Button variant="ghost" size="icon" aria-label="Toggle theme" onClick={toggle}>
        {theme === "dark" ? <Sun /> : <Moon />}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className="ml-1 flex size-7 items-center justify-center rounded-full bg-primary/15 text-[11px] font-semibold text-primary outline-none ring-ring/50 focus-visible:ring-2">
            {initials}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel className="font-normal">
            <div className="text-[13px] font-medium text-foreground">{user?.name}</div>
            <div className="truncate text-xs">{user?.email}</div>
            <div className="mt-1 text-[10px] uppercase tracking-wider">{user?.role}</div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => navigate({ to: "/settings/account" })}>
            <User /> Account
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() =>
              logout.mutate(undefined, {
                onSuccess: () => navigate({ to: "/login", replace: true }),
              })}
          >
            <LogOut /> Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}
