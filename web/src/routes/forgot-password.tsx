import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";
import { authStatusQuery, useAuth, useForgotPassword } from "@/api/auth";
import { ApiError } from "@/api/client";
import { Field } from "@/components/data/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AuthShell, BackToSignIn } from "./login";

export const Route = createFileRoute("/forgot-password")({
  validateSearch: z.object({ email: z.string().optional() }),
  beforeLoad: async ({ context }) => {
    const status = await context.queryClient.ensureQueryData(authStatusQuery);
    if (status.setupRequired) throw redirect({ to: "/setup" });
    if (status.user) throw redirect({ to: "/" });
  },
  component: ForgotPasswordPage,
});

function ForgotPasswordPage() {
  const search = Route.useSearch();
  const { passwordResetAvailable } = useAuth();
  const forgot = useForgotPassword();
  const [email, setEmail] = useState(search.email ?? "");
  const error = forgot.error instanceof ApiError
    ? forgot.error.message
    : forgot.error
    ? "Could not send the email"
    : null;
  const text = "text-sm text-muted-foreground";

  if (forgot.isSuccess) {
    return (
      <AuthShell subtitle="Check your email">
        <div className="grid gap-4">
          <p className={text}>
            If <span className="text-foreground">{email}</span>{" "}
            belongs to an account, we sent it a link to choose a new password. The link works once
            and expires in 30 minutes.
          </p>
          <p className={text}>
            Nothing after a few minutes? Check your spam folder, or ask an administrator to reset
            your password.
          </p>
          <BackToSignIn />
        </div>
      </AuthShell>
    );
  }

  if (!passwordResetAvailable) {
    return (
      <AuthShell subtitle="Reset your password">
        <div className="grid gap-4">
          <p className={text}>
            Password reset by email is not set up on this server. Ask an administrator to reset your
            password.
          </p>
          <BackToSignIn />
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell subtitle="Reset your password">
      <form
        className="grid gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          forgot.mutate(email);
        }}
      >
        <p className={text}>
          Enter the email you sign in with and we'll send you a link to choose a new password.
        </p>
        <Field label="Email" htmlFor="email" error={error}>
          <Input
            id="email"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoFocus
          />
        </Field>
        <Button type="submit" className="mt-1" disabled={forgot.isPending}>
          {forgot.isPending ? "Sending…" : "Send reset link"}
        </Button>
        <BackToSignIn />
      </form>
    </AuthShell>
  );
}
