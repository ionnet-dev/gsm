import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { Plus, Trash2, Users } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { INSTANCE_ROLES, type InstanceRole } from "@gsm/shared";
import { useAuth } from "@/api/auth";
import { errorMessage } from "@/api/client";
import { useInstanceAccess, useInstanceMutations } from "@/api/instances";
import { useUserDirectory } from "@/api/users";
import { ConfirmDialog } from "@/components/data/confirm-dialog";
import { EmptyState } from "@/components/data/empty-state";
import { Field } from "@/components/data/field";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatRelative } from "@/lib/format";

const parent = getRouteApi("/_app/instances/$instanceId");

export const Route = createFileRoute("/_app/instances/$instanceId/access")({
  component: AccessTab,
});

const ROLE_HELP: Record<InstanceRole, string> = {
  owner: "Everything, including sharing and deleting the instance",
  operator: "Start and stop, console commands, files, backups and settings",
  viewer: "Watch the console and status",
};

function AccessTab() {
  const instanceId = Number(parent.useParams().instanceId);
  const { user: me } = useAuth();
  const { data: items = [] } = useInstanceAccess(instanceId);
  const { grant, revoke } = useInstanceMutations();
  const err = (e: Error) => toast.error(errorMessage(e));
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs text-muted-foreground">
          {Object.entries(ROLE_HELP).map(([r, h]) => (
            <div key={r}>
              <span className="font-medium capitalize text-foreground">{r}</span> —{" "}
              {h}. Administrators always have full access.
            </div>
          ))}
        </div>
        <GrantDialog
          exclude={items.map((a) => a.userId)}
          busy={grant.isPending}
          onGrant={(userId, role) =>
            grant.mutate({ id: instanceId, userId, role }, {
              onSuccess: () => toast.success("Access granted"),
              onError: err,
            })}
        />
      </div>
      <div className="rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>User</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Granted</TableHead>
              <TableHead className="w-12" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.length === 0 && (
              <TableRow>
                <TableCell colSpan={4} className="p-0">
                  <EmptyState
                    icon={Users}
                    title="Nobody else has access"
                    description="Share the instance with a user to let them manage it."
                    className="border-0"
                  />
                </TableCell>
              </TableRow>
            )}
            {items.map((a) => (
              <TableRow key={a.userId}>
                <TableCell>
                  <div className="font-medium">
                    {a.name}{" "}
                    {a.userId === me?.id && (
                      <span className="text-xs text-muted-foreground">(you)</span>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground">{a.email}</div>
                </TableCell>
                <TableCell>
                  <Select
                    value={a.role}
                    disabled={a.userId === me?.id}
                    onValueChange={(role) =>
                      grant.mutate(
                        { id: instanceId, userId: a.userId, role: role as InstanceRole },
                        {
                          onError: err,
                        },
                      )}
                  >
                    <SelectTrigger className="h-7 w-32">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {INSTANCE_ROLES.map((r) => (
                        <SelectItem key={r} value={r} className="capitalize">{r}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {formatRelative(a.grantedAt)}
                </TableCell>
                <TableCell>
                  {a.userId !== me?.id && (
                    <ConfirmDialog
                      trigger={
                        <Button variant="ghost" size="icon-sm" aria-label="Revoke">
                          <Trash2 />
                        </Button>
                      }
                      title={`Remove ${a.name}'s access?`}
                      confirmLabel="Remove"
                      onConfirm={() =>
                        revoke.mutate({ id: instanceId, userId: a.userId }, { onError: err })}
                    />
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function GrantDialog(
  { exclude, busy, onGrant }: {
    exclude: number[];
    busy: boolean;
    onGrant: (userId: number, role: InstanceRole) => void;
  },
) {
  const [open, setOpen] = useState(false);
  const [userId, setUserId] = useState<string>("");
  const [role, setRole] = useState<InstanceRole>("operator");
  const { data: users = [] } = useUserDirectory(open);
  const candidates = users.filter((u) => !exclude.includes(u.id) && u.role !== "admin");
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus /> Share
        </Button>
      </DialogTrigger>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Share this instance</DialogTitle>
          <DialogDescription>Administrators already see every instance.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <Field label="User">
            <Select value={userId} onValueChange={setUserId}>
              <SelectTrigger>
                <SelectValue placeholder="Pick a user" />
              </SelectTrigger>
              <SelectContent>
                {candidates.length === 0 && (
                  <SelectItem value="none" disabled>No other users</SelectItem>
                )}
                {candidates.map((u) => (
                  <SelectItem key={u.id} value={String(u.id)}>{u.name} · {u.email}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Role" hint={ROLE_HELP[role]}>
            <Select value={role} onValueChange={(v) => setRole(v as InstanceRole)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {INSTANCE_ROLES.map((r) => (
                  <SelectItem key={r} value={r} className="capitalize">{r}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button
            disabled={!userId || userId === "none" || busy}
            onClick={() => {
              onGrant(Number(userId), role);
              setOpen(false);
              setUserId("");
            }}
          >
            Grant
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
