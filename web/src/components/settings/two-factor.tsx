import { QRCodeSVG } from "qrcode.react";
import { Download, KeyRound, Mail, ShieldCheck, Smartphone } from "lucide-react";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import type { TotpSetup, TwoFactorChallenge, TwoFactorMethod } from "@gsm/shared";
import { useAuth, useTwoFactor, useTwoFactorStatus } from "@/api/auth";
import { ApiError } from "@/api/client";
import { CodeInput, codeReady } from "@/components/auth/code-input";
import { CopyButton } from "@/components/data/copy-button";
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
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { formatDateTime } from "@/lib/format";

const msg = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

type PasswordAction = { kind: "disable"; method: TwoFactorMethod } | { kind: "regenerate" };

export function TwoFactorCard() {
  const { user, emailCodesAvailable } = useAuth();
  const { data: status } = useTwoFactorStatus();
  const tf = useTwoFactor();
  const [settingUpApp, setSettingUpApp] = useState(false);
  const [emailChallenge, setEmailChallenge] = useState<TwoFactorChallenge | null>(null);
  const [confirming, setConfirming] = useState<PasswordAction | null>(null);
  const [newCodes, setNewCodes] = useState<string[] | null>(null);
  const methods = user?.twoFactorMethods ?? [];
  const appOn = methods.includes("totp");
  const emailOn = methods.includes("email");
  const remaining = status?.recoveryCodesRemaining ?? 0;

  const enabled = (what: string, codes: string[] | null) => {
    toast.success(`${what} turned on`);
    if (codes) setNewCodes(codes);
  };

  const runPasswordAction = (password: string) => {
    if (!confirming) return;
    if (confirming.kind === "regenerate") {
      tf.regenerate.mutate(password, {
        onSuccess: (r) => {
          setConfirming(null);
          setNewCodes(r.recoveryCodes);
        },
        onError: (e) => toast.error(msg(e, "Could not generate codes")),
      });
      return;
    }
    const { method } = confirming;
    tf.disable.mutate({ method, password }, {
      onSuccess: () => {
        setConfirming(null);
        toast.success(method === "totp" ? "Authenticator app removed" : "Email codes turned off");
      },
      onError: (e) => toast.error(msg(e, "Failed")),
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Two-factor authentication
          {methods.length
            ? <Badge variant="default">On</Badge>
            : <Badge variant="muted">Off</Badge>}
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        <p className="text-xs text-muted-foreground">
          Sign-in asks for a code after your password. Use an authenticator app, email codes, or
          both: with both, the app is asked for first and email is the fallback. API tokens are not
          affected.
        </p>

        <div className="divide-y rounded-md border">
          <MethodRow
            icon={<Smartphone className="size-4" />}
            title="Authenticator app"
            on={appOn}
            description={appOn
              ? `Set up ${formatDateTime(status?.totpEnabledAt)}. Works even when email is down.`
              : "Google Authenticator, Microsoft Authenticator, 1Password, Authy or any other TOTP app. Works even when email is down."}
          >
            {appOn
              ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setConfirming({ kind: "disable", method: "totp" })}
                >
                  Remove
                </Button>
              )
              : (
                <Button size="sm" onClick={() => setSettingUpApp(true)}>
                  <ShieldCheck /> Set up
                </Button>
              )}
          </MethodRow>

          <MethodRow
            icon={<Mail className="size-4" />}
            title="Email codes"
            on={emailOn}
            description={emailOn
              ? `A code is sent to ${user?.email} when you sign in.`
              : emailCodesAvailable
              ? `Get a code at ${user?.email} each time you sign in.`
              : "Not available: an administrator must set up SMTP under Settings → General."}
            below={emailChallenge && (
              <EmailConfirmForm
                challenge={emailChallenge}
                onChallenge={setEmailChallenge}
                onDone={(codes) => {
                  setEmailChallenge(null);
                  enabled("Email codes", codes);
                }}
              />
            )}
          >
            {emailOn
              ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setConfirming({ kind: "disable", method: "email" })}
                >
                  Turn off
                </Button>
              )
              : !emailChallenge && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!emailCodesAvailable || tf.emailStart.isPending}
                  onClick={() =>
                    tf.emailStart.mutate(undefined, {
                      onSuccess: setEmailChallenge,
                      onError: (e) => toast.error(msg(e, "Could not send the code")),
                    })}
                >
                  {tf.emailStart.isPending ? "Sending code…" : "Turn on"}
                </Button>
              )}
          </MethodRow>

          {methods.length > 0 && (
            <MethodRow
              icon={<KeyRound className="size-4" />}
              title="Recovery codes"
              description={
                <>
                  {remaining}{" "}
                  of 10 unused. Each one signs you in once if you lose your phone or email stops
                  working.
                  {remaining <= 2 && (
                    <span className="text-destructive">
                      {" "}
                      {remaining === 0 ? "You have none left." : "You're running low."}{" "}
                      Generate a new set.
                    </span>
                  )}
                </>
              }
            >
              <Button
                size="sm"
                variant="outline"
                onClick={() => setConfirming({ kind: "regenerate" })}
              >
                Generate new codes
              </Button>
            </MethodRow>
          )}
        </div>
      </CardContent>

      {settingUpApp && (
        <TotpSetupDialog
          onClose={() => setSettingUpApp(false)}
          onEnabled={(codes) => {
            setSettingUpApp(false);
            enabled("Authenticator app", codes);
          }}
        />
      )}
      {confirming && (
        <PasswordDialog
          action={confirming}
          pending={tf.disable.isPending || tf.regenerate.isPending}
          onCancel={() => setConfirming(null)}
          onConfirm={runPasswordAction}
        />
      )}
      {newCodes && (
        <RecoveryCodesDialog
          codes={newCodes}
          email={user?.email ?? ""}
          onClose={() => setNewCodes(null)}
        />
      )}
    </Card>
  );
}

function MethodRow({ icon, title, on, description, below, children }: {
  icon: ReactNode;
  title: string;
  on?: boolean;
  description: ReactNode;
  below?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="grid gap-3 p-3">
      <div className="flex flex-wrap items-start gap-3">
        <div className="mt-0.5 text-muted-foreground">{icon}</div>
        <div className="grid min-w-0 flex-1 basis-48 gap-0.5">
          <div className="flex items-center gap-2 text-sm font-medium">
            {title}
            {on !== undefined &&
              (on ? <Badge variant="outline">On</Badge> : <Badge variant="muted">Off</Badge>)}
          </div>
          <div className="text-xs text-muted-foreground">{description}</div>
        </div>
        <div className="flex shrink-0 gap-2">{children}</div>
      </div>
      {below}
    </div>
  );
}

function EmailConfirmForm({ challenge, onChallenge, onDone }: {
  challenge: TwoFactorChallenge;
  onChallenge: (c: TwoFactorChallenge | null) => void;
  onDone: (codes: string[] | null) => void;
}) {
  const tf = useTwoFactor();
  const [code, setCode] = useState("");
  return (
    <form
      className="grid gap-3 pl-7"
      onSubmit={(e) => {
        e.preventDefault();
        if (!codeReady(code)) return;
        tf.emailConfirm.mutate({ challengeId: challenge.challengeId, code }, {
          onSuccess: (r) => onDone(r.recoveryCodes),
          onError: (err) => toast.error(msg(err, "Invalid code")),
        });
      }}
    >
      <Field
        label={`Enter the code we emailed to ${challenge.sentTo ?? "you"}`}
        htmlFor="tf-email-code"
        hint="This confirms the mailbox works before sign-in depends on it."
      >
        <CodeInput id="tf-email-code" value={code} onChange={setCode} autoFocus />
      </Field>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" disabled={tf.emailConfirm.isPending || !codeReady(code)}>
          Confirm and turn on
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={tf.emailResend.isPending}
          onClick={() =>
            tf.emailResend.mutate(challenge.challengeId, {
              onSuccess: (c) => {
                onChallenge(c);
                setCode("");
                toast.success("New code sent");
              },
              onError: (err) => toast.error(msg(err, "Could not re-send")),
            })}
        >
          Send a new code
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => onChallenge(null)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** Password, then QR code + manual key, then a code from the app to prove it works. */
function TotpSetupDialog({ onClose, onEnabled }: {
  onClose: () => void;
  onEnabled: (codes: string[] | null) => void;
}) {
  const tf = useTwoFactor();
  const [password, setPassword] = useState("");
  const [setup, setSetup] = useState<TotpSetup | null>(null);
  const [code, setCode] = useState("");
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Set up an authenticator app</DialogTitle>
          <DialogDescription>
            {setup
              ? "Scan the QR code with your app, then enter the 6-digit code it shows."
              : "Enter your password to continue."}
          </DialogDescription>
        </DialogHeader>
        {!setup
          ? (
            <form
              className="grid gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                tf.totpStart.mutate(password, {
                  onSuccess: (s) => {
                    setSetup(s);
                    setPassword("");
                  },
                  onError: (err) => toast.error(msg(err, "Could not start setup")),
                });
              }}
            >
              <Field label="Password" htmlFor="totp-password">
                <Input
                  id="totp-password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoFocus
                  required
                />
              </Field>
              <DialogFooter>
                <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
                <Button type="submit" disabled={tf.totpStart.isPending || !password}>
                  Continue
                </Button>
              </DialogFooter>
            </form>
          )
          : (
            <form
              className="grid gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                if (!codeReady(code)) return;
                tf.totpConfirm.mutate(code, {
                  onSuccess: (r) => onEnabled(r.recoveryCodes),
                  onError: (err) => {
                    setCode("");
                    toast.error(msg(err, "Invalid code"));
                  },
                });
              }}
            >
              <div className="flex justify-center">
                {/* Always dark-on-white: some apps cannot read an inverted code. */}
                <div className="rounded-md bg-white p-3">
                  <QRCodeSVG
                    value={setup.otpauthUrl}
                    size={176}
                    marginSize={0}
                    title="QR code for your authenticator app"
                  />
                </div>
              </div>
              <div className="grid gap-1 text-xs text-muted-foreground">
                Can't scan it? Enter this key in the app instead:
                <div className="flex items-center gap-1">
                  <code className="break-all rounded bg-muted px-2 py-1 font-mono text-[13px] text-foreground">
                    {setup.secret.match(/.{1,4}/g)?.join(" ")}
                  </code>
                  <CopyButton value={setup.secret} label="Copy key" />
                </div>
              </div>
              <Field label="Code from the app" htmlFor="totp-code">
                <CodeInput id="totp-code" value={code} onChange={setCode} autoFocus />
              </Field>
              <DialogFooter>
                <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
                <Button type="submit" disabled={tf.totpConfirm.isPending || !codeReady(code)}>
                  <ShieldCheck /> Verify and turn on
                </Button>
              </DialogFooter>
            </form>
          )}
      </DialogContent>
    </Dialog>
  );
}

function PasswordDialog({ action, pending, onCancel, onConfirm }: {
  action: PasswordAction;
  pending: boolean;
  onCancel: () => void;
  onConfirm: (password: string) => void;
}) {
  const [password, setPassword] = useState("");
  const copy = action.kind === "regenerate"
    ? {
      title: "Generate new recovery codes",
      body: "Your current recovery codes will stop working.",
      button: "Generate codes",
    }
    : action.method === "totp"
    ? {
      title: "Remove authenticator app",
      body: "Sign-in will stop asking for codes from your app.",
      button: "Remove app",
    }
    : {
      title: "Turn off email codes",
      body: "Sign-in will stop sending codes to your email.",
      button: "Turn off",
    };
  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="sm:max-w-sm">
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            onConfirm(password);
          }}
        >
          <DialogHeader>
            <DialogTitle>{copy.title}</DialogTitle>
            <DialogDescription>{copy.body} Enter your password to continue.</DialogDescription>
          </DialogHeader>
          <Field label="Password" htmlFor="tf-password">
            <Input
              id="tf-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
              required
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
            <Button
              type="submit"
              variant={action.kind === "disable" ? "destructive" : "default"}
              disabled={pending || !password}
            >
              {copy.button}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RecoveryCodesDialog({ codes, email, onClose }: {
  codes: string[];
  email: string;
  onClose: () => void;
}) {
  const text = codes.join("\n");
  const download = () => {
    const blob = new Blob([`Ionnet GSM recovery codes for ${email}\n\n${text}\n`], {
      type: "text/plain",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "gsm-recovery-codes.txt";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Save your recovery codes</DialogTitle>
          <DialogDescription>
            Each code signs you in once if you lose your phone or email stops working. Keep them
            somewhere safe, like a password manager. They won't be shown again.
          </DialogDescription>
        </DialogHeader>
        <ul className="grid grid-cols-2 gap-x-6 gap-y-1.5 rounded-md border bg-muted/40 p-4 font-mono text-sm">
          {codes.map((c) => <li key={c}>{c}</li>)}
        </ul>
        <DialogFooter className="gap-2 sm:justify-between">
          <div className="flex gap-2">
            <CopyButton value={text} label="Copy all" size="sm" />
            <Button type="button" variant="ghost" size="sm" onClick={download}>
              <Download /> Download
            </Button>
          </div>
          <Button type="button" onClick={onClose}>I've saved them</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
