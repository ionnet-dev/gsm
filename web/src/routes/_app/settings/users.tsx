import { createFileRoute } from "@tanstack/react-router";
import { KeyRound, Plus, ShieldOff, Trash2, UserCheck, UserX } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import type { PublicUser, Role } from "@gsm/shared";
import { ROLES } from "@gsm/shared";
import { useAuth } from "@/api/auth";
import { useUserMutations, useUsers } from "@/api/users";
import { ConfirmDialog } from "@/components/data/confirm-dialog";
import { Field } from "@/components/data/field";
import { Badge } from "@/components/ui/badge";
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
import { Input } from "@/components/ui/input";
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

export const Route = createFileRoute("/_app/settings/users")({
  component: UsersPage,
});

const ROLE_HELP: Record<Role, string> = {
  admin: "Everything: nodes, templates, every instance, users and settings",
  user: "Only the instances shared with them, with the role given per instance",
};

function UsersPage() {
  const { user: me } = useAuth();
  const { data: users = [] } = useUsers();
  const um = useUserMutations();
  const err = (e: Error) => toast.error(e.message);

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs text-muted-foreground">
          {Object.entries(ROLE_HELP).map(([r, h]) => (
            <div key={r}>
              <span className="font-medium capitalize text-foreground">{r}</span> — {h}
            </div>
          ))}
        </div>
        <CreateUserDialog />
      </div>
      <div className="rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>User</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Instances</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Last login</TableHead>
              <TableHead className="w-32" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.map((u) => (
              <TableRow key={u.id}>
                <TableCell>
                  <div className="font-medium">
                    {u.name} {u.id === me?.id && (
                      <span className="text-xs text-muted-foreground">
                        (you)
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground">{u.email}</div>
                </TableCell>
                <TableCell>
                  <Select
                    value={u.role}
                    onValueChange={(role) =>
                      um.update.mutate({ id: u.id, role: role as Role }, { onError: err })}
                    disabled={u.id === me?.id}
                  >
                    <SelectTrigger className="h-7 w-28">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ROLES.map((r) => (
                        <SelectItem key={r} value={r} className="capitalize">{r}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </TableCell>
                <TableCell className="font-mono text-xs">
                  {u.role === "admin" ? "all" : u.instanceCount ?? 0}
                </TableCell>
                <TableCell>
                  <div className="flex gap-1">
                    {u.disabled
                      ? <Badge variant="muted">Disabled</Badge>
                      : <Badge variant="outline">Active</Badge>}
                    {u.twoFactorEnabled && <Badge variant="outline">2FA</Badge>}
                  </div>
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {formatRelative(u.lastLoginAt)}
                </TableCell>
                <TableCell>
                  <div className="flex justify-end gap-1">
                    <ResetPasswordDialog user={u} />
                    {u.twoFactorEnabled && u.id !== me?.id && (
                      <ConfirmDialog
                        trigger={
                          <Button variant="ghost" size="icon-sm" aria-label="Reset two-factor">
                            <ShieldOff />
                          </Button>
                        }
                        title={`Turn off two-factor for ${u.name}?`}
                        description="Use this when they can no longer receive codes. Their sessions are signed out and they can sign in with just their password until they enable it again."
                        confirmLabel="Turn off"
                        onConfirm={() =>
                          um.update.mutate({ id: u.id, twoFactorEnabled: false }, {
                            onSuccess: () => toast.success("Two-factor turned off"),
                            onError: err,
                          })}
                      />
                    )}
                    {u.id !== me?.id && (
                      <>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={u.disabled ? "Enable" : "Disable"}
                          onClick={() =>
                            um.update.mutate({ id: u.id, disabled: !u.disabled }, { onError: err })}
                        >
                          {u.disabled ? <UserCheck /> : <UserX />}
                        </Button>
                        <ConfirmDialog
                          trigger={
                            <Button variant="ghost" size="icon-sm" aria-label="Delete">
                              <Trash2 />
                            </Button>
                          }
                          title={`Delete ${u.name}?`}
                          description="Their sessions end immediately. Audit entries they created are kept."
                          confirmLabel="Delete"
                          onConfirm={() => um.remove.mutate(u.id, { onError: err })}
                        />
                      </>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function CreateUserDialog() {
  const um = useUserMutations();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>("user");
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus /> Add user
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add user</DialogTitle>
          <DialogDescription>
            Share the initial password out of band; they can change it under My account. Share
            instances with them from each instance's Access tab.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <Field label="Name" htmlFor="uname">
            <Input id="uname" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </Field>
          <Field label="Email" htmlFor="uemail">
            <Input
              id="uemail"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
          <Field label="Initial password" htmlFor="upw" hint="At least 10 characters">
            <Input
              id="upw"
              type="text"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="font-mono"
            />
          </Field>
          <Field label="Role">
            <Select value={role} onValueChange={(v) => setRole(v as Role)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ROLES.map((r) => (
                  <SelectItem key={r} value={r} className="capitalize">{r}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button
            disabled={!name || !email || password.length < 10 || um.create.isPending}
            onClick={() =>
              um.create.mutate({ name, email, password, role }, {
                onSuccess: () => {
                  setOpen(false);
                  setName("");
                  setEmail("");
                  setPassword("");
                },
                onError: (e) => toast.error(e.message),
              })}
          >
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ResetPasswordDialog({ user }: { user: PublicUser }) {
  const um = useUserMutations();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="Reset password">
          <KeyRound />
        </Button>
      </DialogTrigger>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Reset password for {user.name}</DialogTitle>
          <DialogDescription>All of their sessions are signed out.</DialogDescription>
        </DialogHeader>
        <Field label="New password" htmlFor="rpw" hint="At least 10 characters">
          <Input
            id="rpw"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="font-mono"
            autoFocus
          />
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button
            disabled={password.length < 10}
            onClick={() =>
              um.resetPassword.mutate({ id: user.id, password }, {
                onSuccess: () => {
                  toast.success("Password reset");
                  setOpen(false);
                  setPassword("");
                },
                onError: (e) => toast.error(e.message),
              })}
          >
            Reset
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
