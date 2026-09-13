import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { RefreshCw, Search, Users } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import type {
  InstanceDetailDto,
  InstancePlayersDto,
  PlayerDto,
  PlayerListEntryDto,
} from "@gsm/shared";
import { RECENT_PLAYER_DAYS, roleAllows } from "@gsm/shared";
import { errorMessage } from "@/api/client";
import { useInstance } from "@/api/instances";
import { usePlayerMutations, usePlayers } from "@/api/players";
import { EmptyState } from "@/components/data/empty-state";
import { ErrorView, PendingView } from "@/components/data/error-view";
import { PlayerActionsMenu } from "@/components/instances/player-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { between, formatDateTime, formatRelative } from "@/lib/format";
import { INSTANCE_STATUS_LABEL } from "@/lib/status";
import { cn } from "@/lib/utils";

const parent = getRouteApi("/_app/instances/$instanceId");

export const Route = createFileRoute("/_app/instances/$instanceId/players")({
  component: PlayersTab,
});

function PlayersTab() {
  const instanceId = Number(parent.useParams().instanceId);
  const { data: instance } = useInstance(instanceId);
  const q = usePlayers(instanceId);
  if (!instance) return null;
  if (q.isLoading) return <PendingView />;
  if (q.error) return <ErrorView error={q.error} reset={() => q.refetch()} />;
  return <PlayersView instance={instance} data={q.data!} />;
}

/** One line of the table: a tracked player, an entry of one of the game's lists, or both. */
interface Row {
  name: string;
  id: string | null;
  player: PlayerDto | null;
  entry: PlayerListEntryDto | null;
}

function PlayersView(
  { instance, data }: { instance: InstanceDetailDto; data: InstancePlayersDto },
) {
  const pm = usePlayerMutations(instance.id);
  const manage = roleAllows(instance.myRole, "players");
  const running = instance.status === "running" || instance.status === "starting";
  const [view, setView] = useState("online");
  const [search, setSearch] = useState("");
  // "Online for" and "last seen" are relative; keep them roughly current.
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  const known = useMemo(
    () => new Map([...data.recent, ...data.online].map((p) => [p.name.toLowerCase(), p])),
    [data],
  );
  const readableLists = useMemo(
    () => new Set(data.lists.filter((l) => !l.error).map((l) => l.id)),
    [data],
  );
  const listsOf = (name: string, id: string | null) =>
    new Set(
      data.lists
        .filter((l) =>
          l.entries.some((e) =>
            e.name.toLowerCase() === name.toLowerCase() || (id !== null && e.id === id)
          )
        )
        .map((l) => l.id),
    );
  const badgeOf = new Map(data.lists.map((l) => [l.id, l.badge || l.label]));
  const onlineNames = data.online.map((p) => p.name);
  const list = data.lists.find((l) => l.id === view) ?? null;
  const currentView = list || view === "recent" ? view : "online";

  const rows: Row[] = list
    ? list.entries.map((e) => ({
      name: e.name,
      id: e.id,
      player: known.get(e.name.toLowerCase()) ?? null,
      entry: e,
    }))
    : (currentView === "recent" ? data.recent : data.online).map((p) => ({
      name: p.name,
      id: p.id,
      player: p,
      entry: null,
    }));
  const needle = search.trim().toLowerCase();
  const filtered = needle ? rows.filter((r) => r.name.toLowerCase().includes(needle)) : rows;

  // A name typed into the search that the panel has never seen can still be acted on (ban or op
  // someone before they join).
  const typed = search.trim();
  let typedIsName = false;
  try {
    typedIsName = typed !== "" && new RegExp(data.namePattern).test(typed);
  } catch {
    typedIsName = false;
  }
  const typedKnown = known.has(typed.toLowerCase()) ||
    data.lists.some((l) => l.entries.some((e) => e.name.toLowerCase() === typed.toLowerCase()));
  const showTyped = manage && data.actions.length > 0 && typedIsName && !typedKnown;

  const columns = list?.columns ?? [];
  // Player, the time column (not on list tabs), the list's columns, the menu.
  const columnCount = 1 + (list ? 0 : 1) + columns.length + (manage ? 1 : 0);

  const menu = (name: string, online: boolean, id: string | null) => (
    <PlayerActionsMenu
      instanceId={instance.id}
      actions={data.actions}
      target={{ name, online, lists: listsOf(name, id) }}
      readableLists={readableLists}
      onlinePlayers={onlineNames}
      running={running}
    />
  );

  const count = (n: number) => <span className="ml-1 text-muted-foreground tabular-nums">{n}</span>;

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Tabs value={currentView} onValueChange={setView}>
          <TabsList className="h-auto flex-wrap">
            <TabsTrigger value="online">Online {count(data.online.length)}</TabsTrigger>
            <TabsTrigger value="recent">Recent {count(data.recent.length)}</TabsTrigger>
            {data.lists.map((l) => (
              <TabsTrigger key={l.id} value={l.id}>
                {l.label} {l.error ? <span className="ml-1 text-status-critical">!</span> : count(
                  l.entries.length,
                )}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="flex-1" />
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={manage ? "Find or type a player name" : "Find a player"}
            className="h-8 w-60 pl-7"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        {manage && (data.canRefresh || data.lists.length > 0) && (
          <Button
            size="sm"
            variant="outline"
            disabled={pm.refresh.isPending}
            onClick={() =>
              pm.refresh.mutate(undefined, { onError: (e) => toast.error(errorMessage(e)) })}
          >
            <RefreshCw className={cn(pm.refresh.isPending && "animate-spin")} /> Refresh
          </Button>
        )}
      </div>

      {!running && (
        <div className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          The server is {INSTANCE_STATUS_LABEL[instance.status].toLowerCase()}.
          {manage && data.actions.length > 0 && " Player actions work while it runs."}
        </div>
      )}
      {list?.error && (
        <div className="rounded-md border border-status-critical/40 bg-status-critical/10 px-3 py-2 text-xs">
          {list.error}
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Player</TableHead>
              {!list && (
                <TableHead>{currentView === "online" ? "Online for" : "Last seen"}</TableHead>
              )}
              {columns.map((c) => <TableHead key={c.key}>{c.label}</TableHead>)}
              {manage && <TableHead className="w-12" />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {showTyped && (
              <TableRow>
                <TableCell colSpan={columnCount - 1}>
                  <div className="flex items-center gap-2.5">
                    <PlayerAvatar name={typed} />
                    <div className="min-w-0">
                      <div className="font-medium">{typed}</div>
                      <div className="text-[11px] text-muted-foreground">
                        Not seen on this server yet; actions work by name.
                      </div>
                    </div>
                  </div>
                </TableCell>
                <TableCell>
                  <div className="flex justify-end">{menu(typed, false, null)}</div>
                </TableCell>
              </TableRow>
            )}
            {filtered.length === 0 && !showTyped && (
              <TableRow>
                <TableCell colSpan={columnCount} className="p-0">
                  <EmptyState
                    icon={Users}
                    className="border-0"
                    {...emptyText(currentView, list?.label ?? null, needle, running)}
                  />
                </TableCell>
              </TableRow>
            )}
            {filtered.map((r) => {
              const online = r.player?.online ?? false;
              const on = listsOf(r.name, r.id);
              return (
                <TableRow key={r.name}>
                  <TableCell>
                    <div className="flex items-center gap-2.5">
                      <PlayerAvatar name={r.name} online={online} />
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="font-medium">{r.name}</span>
                          {online && currentView !== "online" && (
                            <Badge
                              variant="outline"
                              className="border-status-online/40 bg-status-online/10 text-status-online"
                            >
                              Online
                            </Badge>
                          )}
                          {[...on].filter((id) => id !== list?.id).map((id) => (
                            <Badge key={id} variant="muted">{badgeOf.get(id)}</Badge>
                          ))}
                        </div>
                        {r.id && (
                          <div className="truncate font-mono text-[11px] text-muted-foreground">
                            {r.id}
                          </div>
                        )}
                      </div>
                    </div>
                  </TableCell>
                  {!list && (
                    <TableCell
                      className="text-xs text-muted-foreground"
                      title={formatDateTime(online ? r.player?.joinedAt : r.player?.lastSeenAt)}
                    >
                      {online
                        ? between(r.player?.joinedAt, null)
                        : formatRelative(r.player?.lastSeenAt)}
                    </TableCell>
                  )}
                  {columns.map((c) => (
                    <TableCell
                      key={c.key}
                      className="max-w-72 truncate text-xs"
                      title={r.entry?.values[c.key]}
                    >
                      {r.entry?.values[c.key] ?? <span className="text-muted-foreground">—</span>}
                    </TableCell>
                  ))}
                  {manage && (
                    <TableCell>
                      <div className="flex justify-end">{menu(r.name, online, r.id)}</div>
                    </TableCell>
                  )}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      {manage && data.actions.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Actions are console commands from the template; each one is recorded under Activity.
        </p>
      )}
    </div>
  );
}

function emptyText(view: string, listLabel: string | null, needle: string, running: boolean) {
  if (needle) return { title: `No player matches “${needle}”` };
  if (listLabel) return { title: `${listLabel}: nobody yet` };
  if (view === "recent") {
    return {
      title: "No recent players",
      description: `Players who left in the last ${RECENT_PLAYER_DAYS} days show up here.`,
    };
  }
  return running
    ? { title: "Nobody is online", description: "Players show up here as they join." }
    : { title: "Nobody is online", description: "The server is not running." };
}

/** A coloured tile with the name's first letter; the colour is stable per name. */
function PlayerAvatar({ name, online = false }: { name: string; online?: boolean }) {
  let hue = 7;
  for (const ch of name.toLowerCase()) hue = (hue * 31 + ch.charCodeAt(0)) % 360;
  return (
    <span
      className="relative inline-flex size-8 shrink-0 items-center justify-center rounded-md text-sm font-semibold text-white"
      style={{ backgroundColor: `hsl(${hue} 45% 42%)` }}
      aria-hidden
    >
      {name.slice(0, 1).toUpperCase()}
      {online && (
        <span className="absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full border-2 border-card bg-status-online" />
      )}
    </span>
  );
}
