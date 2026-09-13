import { KeyRound, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { errorMessage } from "@/api/client";
import { useSshKeyMutations, useSshKeys } from "@/api/sftp";
import { ConfirmDialog } from "@/components/data/confirm-dialog";
import { Field } from "@/components/data/field";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { formatRelative } from "@/lib/format";

/** The user's SSH public keys, for SFTP to every instance they may manage files on. */
export function SshKeysCard() {
  const { data: keys = [] } = useSshKeys();
  const { add, remove } = useSshKeyMutations();
  const [name, setName] = useState("");
  const [publicKey, setPublicKey] = useState("");
  const err = (e: Error) => toast.error(errorMessage(e));
  return (
    <Card>
      <CardHeader>
        <CardTitle>SSH keys</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        <p className="text-xs text-muted-foreground">
          Sign in to SFTP with a key instead of a password. A key works on every instance you manage
          files on; the username is on each instance's Files tab. Paste the public key, the contents
          of <code className="font-mono">~/.ssh/id_ed25519.pub</code>.
        </p>
        <form
          className="grid gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate({ name: name.trim(), publicKey: publicKey.trim() }, {
              onSuccess: () => {
                toast.success("Key added");
                setName("");
                setPublicKey("");
              },
              onError: err,
            });
          }}
        >
          <Field label="Public key" htmlFor="sshkey">
            <Textarea
              id="sshkey"
              value={publicKey}
              rows={3}
              className="font-mono text-xs"
              placeholder="ssh-ed25519 AAAA… you@laptop"
              onChange={(e) => {
                const value = e.target.value;
                setPublicKey(value);
                // Name it after the key's comment unless the user already typed a name.
                const comment = value.trim().split(/\s+/).slice(2).join(" ");
                if (!name && comment) setName(comment);
              }}
            />
          </Field>
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Name" htmlFor="sshname">
              <Input
                id="sshname"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Laptop"
                className="w-56"
              />
            </Field>
            <Button
              type="submit"
              size="sm"
              disabled={!name.trim() || !publicKey.trim() || add.isPending}
            >
              <Plus /> Add key
            </Button>
          </div>
        </form>
        <div className="grid gap-1">
          {keys.length === 0 && <div className="text-xs text-muted-foreground">No SSH keys.</div>}
          {keys.map((k) => (
            <div
              key={k.id}
              className="flex items-center gap-3 rounded-md border px-3 py-2 text-[13px]"
            >
              <KeyRound className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="font-medium">{k.name}</div>
                <div className="truncate font-mono text-xs text-muted-foreground">
                  {k.fingerprint}
                </div>
              </div>
              <Badge variant="muted" className="font-mono">{k.type.replace(/^ssh-/, "")}</Badge>
              <div className="text-xs text-muted-foreground">
                used {formatRelative(k.lastUsedAt)}
              </div>
              <ConfirmDialog
                trigger={
                  <Button variant="ghost" size="icon-sm" aria-label="Remove key">
                    <Trash2 />
                  </Button>
                }
                title={`Remove the key ${k.name}?`}
                description="SFTP sign-ins with it stop working and its open connections close."
                confirmLabel="Remove"
                onConfirm={() => remove.mutate(k.id, { onError: err })}
              />
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
