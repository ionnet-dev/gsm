import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { useAuth, useChangePassword } from "@/api/auth";
import { ApiError } from "@/api/client";
import { Field } from "@/components/data/field";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ApiTokensCard } from "@/components/settings/api-tokens";
import { SshKeysCard } from "@/components/settings/ssh-keys";
import { TwoFactorCard } from "@/components/settings/two-factor";

export const Route = createFileRoute("/_app/settings/account")({
  component: Account,
});

function Account() {
  const { user } = useAuth();
  const change = useChangePassword();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const mismatch = confirm.length > 0 && confirm !== next;
  return (
    <div className="grid max-w-xl gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Profile</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1 text-[13px]">
          <span className="text-muted-foreground">Name</span>
          <span>{user?.name}</span>
          <span className="text-muted-foreground">Email</span>
          <span>{user?.email}</span>
          <span className="text-muted-foreground">Role</span>
          <span className="capitalize">{user?.role}</span>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Change password</CardTitle>
        </CardHeader>
        <CardContent>
          <form
            className="grid gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (mismatch) return;
              change.mutate(
                { currentPassword: current, newPassword: next },
                {
                  onSuccess: () => {
                    toast.success("Password updated; other sessions were signed out");
                    setCurrent("");
                    setNext("");
                    setConfirm("");
                  },
                  onError: (err) => toast.error(err instanceof ApiError ? err.message : "Failed"),
                },
              );
            }}
          >
            <Field label="Current password" htmlFor="cur">
              <Input
                id="cur"
                type="password"
                autoComplete="current-password"
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
                required
              />
            </Field>
            <Field label="New password" htmlFor="new" hint="At least 10 characters">
              <Input
                id="new"
                type="password"
                autoComplete="new-password"
                minLength={10}
                value={next}
                onChange={(e) => setNext(e.target.value)}
                required
              />
            </Field>
            <Field
              label="Confirm new password"
              htmlFor="conf"
              error={mismatch ? "Passwords do not match" : null}
            >
              <Input
                id="conf"
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
              />
            </Field>
            <Button
              type="submit"
              className="justify-self-start"
              disabled={change.isPending || mismatch}
            >
              Update password
            </Button>
          </form>
        </CardContent>
      </Card>
      <TwoFactorCard />
      <SshKeysCard />
      <ApiTokensCard />
    </div>
  );
}
