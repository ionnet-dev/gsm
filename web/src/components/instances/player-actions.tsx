import { Fragment, useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  Ban,
  Ellipsis,
  Eraser,
  Gamepad2,
  Gift,
  Loader2,
  LogOut,
  MapPin,
  MessageSquare,
  ShieldMinus,
  ShieldPlus,
  Skull,
  Terminal,
  Undo2,
  UserMinus,
  UserPlus,
} from "lucide-react";
import { toast } from "sonner";
import type { PlayerActionIcon, TemplatePlayerAction } from "@gsm/shared";
import { errorMessage } from "@/api/client";
import { usePlayerMutations } from "@/api/players";
import { ConfirmDialog } from "@/components/data/confirm-dialog";
import { Field } from "@/components/data/field";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const ICONS: Record<PlayerActionIcon, LucideIcon> = {
  command: Terminal,
  message: MessageSquare,
  gamemode: Gamepad2,
  teleport: MapPin,
  give: Gift,
  clear: Eraser,
  kill: Skull,
  kick: LogOut,
  ban: Ban,
  unban: Undo2,
  op: ShieldPlus,
  deop: ShieldMinus,
  whitelist: UserPlus,
  unwhitelist: UserMinus,
};

export interface PlayerTarget {
  name: string;
  online: boolean;
  /** Ids of the lists the player is on. */
  lists: Set<string>;
}

/**
 * What the server will type, for the confirmation text. The server builds the real command and
 * checks every value; this only mirrors how empty optional fields drop out.
 */
function preview(action: TemplatePlayerAction, player: string, values: Record<string, string>) {
  const all: Record<string, string> = { PLAYER: player, PLAYER_ID: player, ...values };
  return action.command.replace(
    /( ?)\{\{\s*([A-Z][A-Z0-9_]*)\s*\}\}/g,
    (m, space: string, name: string) =>
      name in all ? (all[name].trim() === "" ? "" : space + all[name].trim()) : m,
  ).trim();
}

/**
 * The template's actions for one player, grouped as the template groups them. An action tied to a
 * list shows only when it fits (Ban for players not banned, Unban for banned ones); when that list
 * could not be read (`readableLists`), it shows either way.
 */
export function PlayerActionsMenu({
  instanceId,
  actions,
  target,
  readableLists,
  onlinePlayers,
  running,
}: {
  instanceId: number;
  actions: TemplatePlayerAction[];
  target: PlayerTarget;
  readableLists: Set<string>;
  onlinePlayers: string[];
  running: boolean;
}) {
  const pm = usePlayerMutations(instanceId);
  const [withFields, setWithFields] = useState<TemplatePlayerAction | null>(null);
  const [confirm, setConfirm] = useState<TemplatePlayerAction | null>(null);
  const shown = actions.filter((a) =>
    !a.when || !readableLists.has(a.when.list) || target.lists.has(a.when.list) === a.when.is
  );
  if (!shown.length) return null;

  const groups = new Map<string, TemplatePlayerAction[]>();
  for (const a of shown) groups.set(a.group, [...(groups.get(a.group) ?? []), a]);

  const run = (a: TemplatePlayerAction, fields: Record<string, string>, done?: () => void) =>
    pm.action.mutate({ action: a.id, player: target.name, fields }, {
      onSuccess: (r) => {
        toast.success(`Sent “${r.command}”`);
        done?.();
      },
      onError: (e) => toast.error(errorMessage(e)),
    });
  const pick = (a: TemplatePlayerAction) => {
    if (a.fields.length) setWithFields(a);
    else if (a.danger) setConfirm(a);
    else run(a, {});
  };

  return (
    <>
      {/* Not modal: a dialog opened from an item must get the pointer back. */}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${target.name}`}>
            {pm.action.isPending ? <Loader2 className="animate-spin" /> : <Ellipsis />}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          {[...groups].map(([group, items], gi) => (
            <Fragment key={group || `group-${gi}`}>
              {gi > 0 && <DropdownMenuSeparator />}
              {group && <DropdownMenuLabel>{group}</DropdownMenuLabel>}
              {items.map((a) => {
                const Icon = ICONS[a.icon] ?? Terminal;
                const needsOnline = a.online && !target.online;
                return (
                  <DropdownMenuItem
                    key={a.id}
                    variant={a.danger ? "destructive" : "default"}
                    disabled={!running || needsOnline}
                    onSelect={() => pick(a)}
                  >
                    <Icon />
                    <span className="flex-1">{a.label}</span>
                    {needsOnline && (
                      <span className="text-[10px] text-muted-foreground">offline</span>
                    )}
                  </DropdownMenuItem>
                );
              })}
            </Fragment>
          ))}
          {!running && (
            <>
              <DropdownMenuSeparator />
              <div className="px-2 py-1.5 text-[11px] text-muted-foreground">
                Start the server to use these.
              </div>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {withFields && (
        <ActionDialog
          action={withFields}
          player={target.name}
          onlinePlayers={onlinePlayers}
          busy={pm.action.isPending}
          onClose={() => setWithFields(null)}
          onRun={(values) => run(withFields, values, () => setWithFields(null))}
        />
      )}
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={confirm ? `${confirm.label} · ${target.name}` : ""}
        description={confirm
          ? `Types “${preview(confirm, target.name, {})}” into the server console.`
          : undefined}
        confirmLabel={confirm?.label}
        onConfirm={() => confirm && run(confirm, {})}
      />
    </>
  );
}

function ActionDialog({
  action,
  player,
  onlinePlayers,
  busy,
  onClose,
  onRun,
}: {
  action: TemplatePlayerAction;
  player: string;
  onlinePlayers: string[];
  busy: boolean;
  onClose: () => void;
  onRun: (values: Record<string, string>) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(action.fields.map((f) => [f.name, f.default]))
  );
  const others = onlinePlayers.filter((n) => n.toLowerCase() !== player.toLowerCase());
  const missing = action.fields.some((f) => f.required && !values[f.name]?.trim());
  const set = (name: string, value: string) => setValues((v) => ({ ...v, [name]: value }));
  const formId = `player-action-${action.id}`;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{action.label} · {player}</DialogTitle>
          <DialogDescription>
            Types{" "}
            <code className="font-mono text-foreground">{preview(action, player, values)}</code>
            {" "}
            into the server console.
          </DialogDescription>
        </DialogHeader>
        <form
          id={formId}
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!missing && !busy) onRun(values);
          }}
        >
          {action.fields.map((f, i) => {
            const id = `${formId}-${f.name}`;
            const label = f.required ? f.label : `${f.label} (optional)`;
            if (f.type === "select" || f.type === "player") {
              const options = f.type === "select"
                ? f.options
                : others.map((n) => ({ value: n, label: n }));
              return (
                <Field key={f.name} label={label} htmlFor={id}>
                  <Select
                    value={values[f.name] ?? ""}
                    onValueChange={(v) => set(f.name, v)}
                    disabled={options.length === 0}
                  >
                    <SelectTrigger id={id}>
                      <SelectValue
                        placeholder={options.length ? "Choose…" : "Nobody else is online"}
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {options.map((o) => (
                        <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              );
            }
            return (
              <Field key={f.name} label={label} htmlFor={id}>
                <Input
                  id={id}
                  type={f.type === "number" ? "number" : "text"}
                  min={f.min ?? undefined}
                  max={f.max ?? undefined}
                  maxLength={200}
                  value={values[f.name] ?? ""}
                  placeholder={f.placeholder}
                  autoFocus={i === 0}
                  autoComplete="off"
                  onChange={(e) => set(f.name, e.target.value)}
                />
              </Field>
            );
          })}
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button
            type="submit"
            form={formId}
            variant={action.danger ? "destructive" : "default"}
            disabled={busy || missing}
          >
            {busy && <Loader2 className="animate-spin" />}
            {action.label}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
