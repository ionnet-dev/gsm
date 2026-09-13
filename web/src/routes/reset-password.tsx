import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { useState } from "react";
import { authStatusQuery, useResetPassword } from "@/api/auth";
import { ApiError } from "@/api/client";
import { Field } from "@/components/data/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AuthShell, BackToSignIn } from "./login";

// Open to signed-in users too: the link may be for another account, and resetting signs out anyway.
export const Route = createFileRoute("/reset-password")({
  beforeLoad: async ({ context }) => {
    const status = await context.queryClient.ensureQueryData(authStatusQuery);
    if (status.setupRequired) throw redirect({ to: "/setup" });
  },
  component: ResetPasswordPage,
});

function ResetPasswordPage() {
  // The emailed link carries the token in the fragment, which the browser never sends to a server.
  const [token] = useState(() => window.location.hash.slice(1));
  const reset = useResetPassword();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const mismatch = confirm.length > 0 && confirm !== password;
  const expired = reset.error instanceof ApiError && reset.error.code === "invalid_reset_token";
  const error = reset.error instanceof ApiError
    ? reset.error.message
    : reset.error
    ? "Could not change the password"
    : null;

  if (reset.isSuccess) {
    return (
      <AuthShell subtitle="Password changed">
        <div className="grid gap-4">
          <p className="text-sm text-muted-foreground">
            Your password was changed and you were signed out everywhere. Sign in with the new
            password.
          </p>
          <Button asChild>
            <Link to="/login">Sign in</Link>
          </Button>
        </div>
      </AuthShell>
    );
  }

  if (!token || expired) {
    return (
      <AuthShell subtitle="Reset your password">
        <div className="grid gap-4">
          <p className="text-sm text-destructive">
            {expired
              ? error
              : "This reset link is incomplete. Open the link from the email again, or ask for a new one."}
          </p>
          <Button asChild>
            <Link to="/forgot-password">Ask for a new link</Link>
          </Button>
          <BackToSignIn />
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell subtitle="Choose a new password">
      <form
        className="grid gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (mismatch) return;
          reset.mutate({ token, newPassword: password });
        }}
      >
        <Field label="New password" htmlFor="password" hint="At least 10 characters">
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            minLength={10}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoFocus
          />
        </Field>
        <Field
          label="Confirm password"
          htmlFor="confirm"
          error={mismatch ? "Passwords do not match" : error}
        >
          <Input
            id="confirm"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
          />
        </Field>
        <Button type="submit" className="mt-1" disabled={reset.isPending}>
          {reset.isPending ? "Saving…" : "Set new password"}
        </Button>
        <BackToSignIn />
      </form>
    </AuthShell>
  );
}
