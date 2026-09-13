import { createFileRoute } from "@tanstack/react-router";
import { Ban, KeySquare, Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useEnrollmentMutations, useEnrollmentTokens } from "@/api/nodes";
import { CopyButton } from "@/components/data/copy-button";
import { EmptyState } from "@/components/data/empty-state";
import { Field } from "@/components/data/field";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatRelative } from "@/lib/format";

export const Route = createFileRoute("/_app/settings/enrollment")({
  component: EnrollmentPage,
});

function installCommand(token: string) {
  return `curl -fsSL ${location.origin}/install.sh | sudo sh -s -- --server ${location.origin} --token ${token}`;
}

function EnrollmentPage() {
  const { data: tokens = [] } = useEnrollmentTokens();
  const em = useEnrollmentMutations();
  const [issued, setIssued] = useState<string | null>(null);

  return (
    <div className="grid gap-4">
      {issued && (
        <Card className="border-primary/40">
          <CardHeader>
            <CardTitle className="text-primary">Token issued — shown once</CardTitle>
            <Button variant="ghost" size="sm" onClick={() => setIssued(null)}>
              Dismiss
            </Button>
          </CardHeader>
          <CardContent className="grid gap-3">
            <div className="text-xs text-muted-foreground">
              Run this on the node (a Linux machine with Docker and systemd) to install the agent
              and enroll it. The token is not stored in plaintext; copy it now.
            </div>
            <div className="flex items-start gap-2 rounded-md border bg-black/40 p-2 font-mono text-xs break-all">
              <span className="flex-1">{installCommand(issued)}</span>
              <CopyButton value={installCommand(issued)} />
            </div>
            <div className="text-xs text-muted-foreground">
              Or, with the binary already present:{" "}
              <code className="font-mono">
                sudo gsm-agent enroll -server {location.origin} -token {issued}
              </code>
            </div>
          </CardContent>
        </Card>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs text-muted-foreground">
          Enrollment tokens let agents register a node. Give each token a purpose, a use limit and
          an expiry, and revoke it when the install is done.
        </div>
        <CreateTokenDialog onIssued={setIssued} />
      </div>
      <div className="rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Token</TableHead>
              <TableHead>Uses</TableHead>
              <TableHead>Expires</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-12" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {tokens.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="p-0">
                  <EmptyState
                    icon={KeySquare}
                    title="No enrollment tokens"
                    description="Create one to enroll your first node."
                    className="border-0"
                  />
                </TableCell>
              </TableRow>
            )}
            {tokens.map((t) => (
              <TableRow key={t.id}>
                <TableCell>
                  <div className="font-medium">{t.name}</div>
                  <div className="font-mono text-xs text-muted-foreground">{t.tokenPrefix}…</div>
                </TableCell>
                <TableCell className="font-mono text-xs">
                  {t.uses}
                  {t.maxUses ? ` / ${t.maxUses}` : ""}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {t.expiresAt ? formatRelative(t.expiresAt) : "never"}
                </TableCell>
                <TableCell>
                  {t.revokedAt
                    ? <Badge variant="muted">Revoked</Badge>
                    : t.usable
                    ? <Badge variant="outline">Active</Badge>
                    : <Badge variant="muted">Exhausted</Badge>}
                </TableCell>
                <TableCell>
                  {t.usable && (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Revoke"
                      onClick={() =>
                        em.revoke.mutate(t.id, { onError: (e) => toast.error(e.message) })}
                    >
                      <Ban />
                    </Button>
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

function CreateTokenDialog({ onIssued }: { onIssued: (plaintext: string) => void }) {
  const em = useEnrollmentMutations();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [maxUses, setMaxUses] = useState<string>("1");
  const [expires, setExpires] = useState<string>("24");
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus /> New token
        </Button>
      </DialogTrigger>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>New enrollment token</DialogTitle>
          <DialogDescription>Short-lived, single-use tokens are safest.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <Field label="Name" htmlFor="tname" hint="e.g. 'Hetzner node 3'">
            <Input id="tname" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Max uses" htmlFor="muses" hint="Empty = unlimited">
              <Input
                id="muses"
                type="number"
                min={1}
                value={maxUses}
                onChange={(e) => setMaxUses(e.target.value)}
              />
            </Field>
            <Field label="Expires in (hours)" htmlFor="exp" hint="Empty = never">
              <Input
                id="exp"
                type="number"
                min={1}
                value={expires}
                onChange={(e) => setExpires(e.target.value)}
              />
            </Field>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button
            disabled={!name.trim() || em.create.isPending}
            onClick={() =>
              em.create.mutate(
                {
                  name: name.trim(),
                  maxUses: maxUses ? Number(maxUses) : null,
                  expiresInHours: expires ? Number(expires) : null,
                },
                {
                  onSuccess: (r) => {
                    onIssued(r.plaintext);
                    setOpen(false);
                    setName("");
                  },
                  onError: (e) => toast.error(e.message),
                },
              )}
          >
            Create token
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
