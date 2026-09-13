import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { authStatusQuery, useSetup } from "@/api/auth";
import { ApiError } from "@/api/client";
import { Field } from "@/components/data/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AuthShell } from "./login";

export const Route = createFileRoute("/setup")({
  beforeLoad: async ({ context }) => {
    const status = await context.queryClient.ensureQueryData(authStatusQuery);
    if (!status.setupRequired) throw redirect({ to: status.user ? "/" : "/login" });
  },
  component: SetupPage,
});

function SetupPage() {
  const navigate = useNavigate();
  const setup = useSetup();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const mismatch = confirm.length > 0 && confirm !== password;
  const error = setup.error instanceof ApiError ? setup.error.message : null;

  return (
    <AuthShell subtitle="Welcome. Create the first administrator account.">
      <form
        className="grid gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (mismatch) return;
          setup.mutate({ name, email, password }, {
            onSuccess: () => navigate({ to: "/", replace: true }),
          });
        }}
      >
        <Field label="Your name" htmlFor="name">
          <Input
            id="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            autoFocus
          />
        </Field>
        <Field label="Email" htmlFor="email">
          <Input
            id="email"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </Field>
        <Field label="Password" htmlFor="password" hint="At least 10 characters">
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            minLength={10}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
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
        <Button type="submit" className="mt-1" disabled={setup.isPending || mismatch}>
          {setup.isPending ? "Creating…" : "Create administrator"}
        </Button>
      </form>
    </AuthShell>
  );
}
