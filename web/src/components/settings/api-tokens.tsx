import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { del, get, post } from "@/api/client";
import { ConfirmDialog } from "@/components/data/confirm-dialog";
import { CopyButton } from "@/components/data/copy-button";
import { Field } from "@/components/data/field";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { formatRelative } from "@/lib/format";

interface TokenDto {
  id: number;
  name: string;
  tokenPrefix: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export function ApiTokensCard() {
  const qc = useQueryClient();
  const { data: tokens = [] } = useQuery({
    queryKey: ["api-tokens"],
    queryFn: () => get<{ items: TokenDto[] }>("/auth/tokens"),
    select: (d) => d.items,
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: ["api-tokens"] });
  const create = useMutation({
    mutationFn: (b: { name: string; expiresInDays: number | null }) =>
      post<{ token: TokenDto; plaintext: string }>("/auth/tokens", b),
    onSuccess: invalidate,
  });
  const revoke = useMutation({
    mutationFn: (id: number) => del<{ ok: true }>(`/auth/tokens/${id}`),
    onSuccess: invalidate,
  });
  const [name, setName] = useState("");
  const [days, setDays] = useState("90");
  const [issued, setIssued] = useState<string | null>(null);
  const active = tokens.filter((t) => !t.revokedAt);

  return (
    <Card>
      <CardHeader>
        <CardTitle>API tokens</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        <p className="text-xs text-muted-foreground">
          Tokens act as you with your role. Send them as{" "}
          <code className="font-mono">Authorization: Bearer gsm_api_…</code>; no CSRF header is
          needed.
        </p>
        {issued && (
          <div className="rounded-md border border-primary/40 bg-primary/5 p-3">
            <div className="mb-1 text-xs font-medium text-primary">
              Token created — copy it now, it is shown once
            </div>
            <div className="flex items-center gap-2 font-mono text-xs break-all">
              {issued} <CopyButton value={issued} />
            </div>
            <div className="mt-2 rounded bg-black/30 p-2 font-mono text-[11px] text-muted-foreground">
              curl -H "Authorization: Bearer {issued}" {location.origin}/api/v1/machines
            </div>
          </div>
        )}
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate(
              { name: name.trim(), expiresInDays: days ? Number(days) : null },
              {
                onSuccess: (r) => {
                  setIssued(r.plaintext);
                  setName("");
                },
                onError: (err) => toast.error(err.message),
              },
            );
          }}
        >
          <Field label="Name" htmlFor="tokname">
            <Input
              id="tokname"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="CI deploy"
              className="w-56"
            />
          </Field>
          <Field label="Expires in (days)" htmlFor="tokdays" hint="Empty = never">
            <Input
              id="tokdays"
              type="number"
              min={1}
              value={days}
              onChange={(e) => setDays(e.target.value)}
              className="w-32"
            />
          </Field>
          <Button type="submit" size="sm" disabled={!name.trim() || create.isPending}>
            <Plus /> Create token
          </Button>
        </form>
        <div className="grid gap-1">
          {active.length === 0 && (
            <div className="text-xs text-muted-foreground">No active tokens.</div>
          )}
          {active.map((t) => (
            <div
              key={t.id}
              className="flex items-center gap-3 rounded-md border px-3 py-2 text-[13px]"
            >
              <KeyRound className="size-4 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="font-medium">{t.name}</div>
                <div className="font-mono text-xs text-muted-foreground">{t.tokenPrefix}…</div>
              </div>
              <div className="text-xs text-muted-foreground">
                used {formatRelative(t.lastUsedAt)}
              </div>
              <Badge variant="muted">
                {t.expiresAt ? `expires ${formatRelative(t.expiresAt)}` : "no expiry"}
              </Badge>
              <ConfirmDialog
                trigger={
                  <Button variant="ghost" size="icon-sm" aria-label="Revoke">
                    <Trash2 />
                  </Button>
                }
                title={`Revoke token ${t.name}?`}
                description="Anything using it stops working immediately."
                confirmLabel="Revoke"
                onConfirm={() => revoke.mutate(t.id, { onError: (e) => toast.error(e.message) })}
              />
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
