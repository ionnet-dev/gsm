import { createFileRoute, Link, redirect, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";
import type { SecondFactor, TwoFactorChallenge, TwoFactorMethod } from "@gsm/shared";
import { authStatusQuery, useAuth, useLogin, useResendLoginCode, useVerifyLogin } from "@/api/auth";
import { ApiError } from "@/api/client";
import { CodeInput, codeReady } from "@/components/auth/code-input";
import { Field } from "@/components/data/field";
import { GsmMark } from "@/components/layout/gsm-mark";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export const Route = createFileRoute("/login")({
  validateSearch: z.object({ redirect: z.string().optional() }),
  beforeLoad: async ({ context }) => {
    const status = await context.queryClient.ensureQueryData(authStatusQuery);
    if (status.setupRequired) throw redirect({ to: "/setup" });
    if (status.user) throw redirect({ to: "/" });
  },
  component: LoginPage,
});

function errorMessage(err: unknown, fallback: string): string | null {
  if (!err) return null;
  return err instanceof ApiError ? err.message : fallback;
}

function LoginPage() {
  const { redirect: to } = Route.useSearch();
  const navigate = useNavigate();
  const [challenge, setChallenge] = useState<TwoFactorChallenge | null>(null);
  const done = () => navigate({ to: to ?? "/", replace: true });

  return (
    <AuthShell subtitle={challenge ? "Two-step verification" : "Sign in to continue"}>
      {challenge
        ? (
          <CodeStep
            challenge={challenge}
            onDone={done}
            onRestart={() => setChallenge(null)}
            onResent={setChallenge}
          />
        )
        : (
          <PasswordStep
            onDone={done}
            onChallenge={setChallenge}
          />
        )}
    </AuthShell>
  );
}

function PasswordStep(
  { onDone, onChallenge }: { onDone: () => void; onChallenge: (c: TwoFactorChallenge) => void },
) {
  const login = useLogin();
  const { passwordResetAvailable } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const error = errorMessage(login.error, "Login failed");

  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        login.mutate({ email, password }, {
          onSuccess: (res) => res.twoFactorRequired ? onChallenge(res) : onDone(),
        });
      }}
    >
      <Field label="Email" htmlFor="email">
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
      <Field label="Password" htmlFor="password" error={error}>
        <Input
          id="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
      </Field>
      <Button type="submit" className="mt-1" disabled={login.isPending}>
        {login.isPending ? "Signing in…" : "Sign in"}
      </Button>
      {passwordResetAvailable && (
        <Link
          to="/forgot-password"
          search={{ email: email || undefined }}
          className="justify-self-center text-xs text-muted-foreground hover:text-foreground"
        >
          Forgot password?
        </Link>
      )}
    </form>
  );
}

const LABELS: Record<SecondFactor, string> = {
  totp: "Authenticator code",
  email: "Sign-in code",
  recovery: "Recovery code",
};

function CodeStep({ challenge, onDone, onRestart, onResent }: {
  challenge: TwoFactorChallenge;
  onDone: () => void;
  onRestart: () => void;
  onResent: (c: TwoFactorChallenge) => void;
}) {
  const verify = useVerifyLogin();
  const resend = useResendLoginCode();
  const [method, setMethod] = useState<SecondFactor>(challenge.methods[0] ?? "recovery");
  const [code, setCode] = useState("");
  const error = errorMessage(verify.error, "Verification failed");
  const resendError = errorMessage(resend.error, "Could not send the code");
  const exhausted = verify.error instanceof ApiError && verify.error.status === 401 &&
    /start again/i.test(verify.error.message);
  const ready = method === "recovery" ? code.replace(/[\s-]/g, "").length === 12 : codeReady(code);
  const offers = (m: TwoFactorMethod) => challenge.methods.includes(m);

  const choose = (m: SecondFactor) => {
    setMethod(m);
    setCode("");
    verify.reset();
  };
  const sendEmail = () =>
    resend.mutate(challenge.challengeId, {
      onSuccess: (c) => {
        onResent(c);
        choose("email");
      },
    });

  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready) return;
        verify.mutate({ challengeId: challenge.challengeId, code, method }, { onSuccess: onDone });
      }}
    >
      <Prompt method={method} challenge={challenge} />
      <Field label={LABELS[method]} htmlFor="code" error={error}>
        {method === "recovery"
          ? (
            <Input
              id="code"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="xxxx-xxxx-xxxx"
              className="font-mono tracking-wider"
              value={code}
              onChange={(e) => setCode(e.target.value.slice(0, 20))}
              autoFocus
              disabled={exhausted}
              required
            />
          )
          : <CodeInput id="code" value={code} onChange={setCode} autoFocus disabled={exhausted} />}
      </Field>
      <Button type="submit" disabled={verify.isPending || !ready || exhausted}>
        {verify.isPending ? "Verifying…" : "Verify"}
      </Button>
      <div className="grid gap-1.5 text-xs text-muted-foreground">
        {method !== "totp" && offers("totp") && (
          <Alt onClick={() => choose("totp")}>Use your authenticator app</Alt>
        )}
        {method === "email" && (
          <Alt onClick={sendEmail} disabled={resend.isPending || exhausted}>
            {resend.isPending ? "Sending…" : "Send a new code"}
          </Alt>
        )}
        {method !== "email" && offers("email") && (
          <Alt
            onClick={() => (challenge.sentTo ? choose("email") : sendEmail())}
            disabled={resend.isPending || exhausted}
          >
            {resend.isPending ? "Sending…" : "Email me a code instead"}
          </Alt>
        )}
        {method !== "recovery" && <Alt onClick={() => choose("recovery")}>Use a recovery code</Alt>}
        <Alt onClick={onRestart}>← Start over</Alt>
      </div>
      {resendError && <p className="text-xs text-destructive">{resendError}</p>}
    </form>
  );
}

function Prompt({ method, challenge }: { method: SecondFactor; challenge: TwoFactorChallenge }) {
  const text = "text-sm text-muted-foreground";
  if (method === "totp") {
    return <p className={text}>Open your authenticator app and enter the current 6-digit code.</p>;
  }
  if (method === "recovery") {
    return (
      <p className={text}>
        Enter one of the recovery codes you saved when you turned on two-factor authentication. Each
        code works once.
      </p>
    );
  }
  if (!challenge.sentTo) {
    return (
      <p className="text-sm text-destructive">
        {challenge.emailError ?? "No code has been sent yet."}{" "}
        You can sign in with a recovery code instead.
      </p>
    );
  }
  return (
    <p className={text}>
      We sent a 6-digit sign-in code to{" "}
      <span className="text-foreground">{challenge.sentTo}</span>. It expires in about{" "}
      {Math.max(1, Math.round(challenge.expiresInSeconds / 60))} minutes.
    </p>
  );
}

function Alt(
  { onClick, disabled, children }: {
    onClick: () => void;
    disabled?: boolean;
    children: React.ReactNode;
  },
) {
  return (
    <button
      type="button"
      className="justify-self-start hover:text-foreground disabled:opacity-50"
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

export function BackToSignIn() {
  return (
    <Link
      to="/login"
      className="justify-self-start text-xs text-muted-foreground hover:text-foreground"
    >
      ← Back to sign in
    </Link>
  );
}

export function AuthShell({ subtitle, children }: { subtitle: string; children: React.ReactNode }) {
  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background p-4">
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.07]"
        style={{
          backgroundImage:
            "linear-gradient(var(--primary) 1px, transparent 1px), linear-gradient(90deg, var(--primary) 1px, transparent 1px)",
          backgroundSize: "32px 32px",
          maskImage: "radial-gradient(ellipse at center, black 30%, transparent 70%)",
        }}
      />
      <div className="relative w-full max-w-sm rounded-lg border bg-card p-8 shadow-2xl">
        <div className="mb-6 flex items-center gap-3">
          <GsmMark className="size-9" />
          <div>
            <div className="text-base font-semibold leading-tight">Ionnet GSM</div>
            <div className="text-xs text-muted-foreground">{subtitle}</div>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}
