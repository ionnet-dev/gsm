import type { Role, TwoFactorMethod } from "../enums.ts";

export interface PublicUser {
  id: number;
  email: string;
  name: string;
  role: Role;
  disabled: boolean;
  /** True when at least one second factor is on. */
  twoFactorEnabled: boolean;
  /** Second factors that are on, authenticator app first. */
  twoFactorMethods: TwoFactorMethod[];
  lastLoginAt: string | null;
  createdAt: string;
  /** Only on the administrator's user list: how many instances the user has access to. */
  instanceCount?: number;
}

export interface AuthStatus {
  setupRequired: boolean;
  user: PublicUser | null;
  /** True when SMTP is configured, so email codes can be turned on and delivered. */
  emailCodesAvailable: boolean;
  /** True when SMTP is configured, so "Forgot password?" can email a reset link. */
  passwordResetAvailable: boolean;
}

/** A pending second-factor step: signing in, or proving a mailbox while turning on email codes. */
export interface TwoFactorChallenge {
  challengeId: string;
  /** Methods the user can answer with, preferred first. Unused recovery codes work too. */
  methods: TwoFactorMethod[];
  /** Masked address the latest email code went to, e.g. "l***@example.com"; null if none was. */
  sentTo: string | null;
  /** Why an email code that should have gone out did not; the challenge stays usable. */
  emailError: string | null;
  expiresInSeconds: number;
}

export type LoginResult =
  | { user: PublicUser; twoFactorRequired?: false }
  | ({ twoFactorRequired: true } & TwoFactorChallenge);

/** The signed-in user's second-factor setup (Settings → My account). */
export interface TwoFactorStatus {
  methods: TwoFactorMethod[];
  totpEnabledAt: string | null;
  recoveryCodesRemaining: number;
}

/** Returned when authenticator setup starts; the key is also inside the otpauth URL. */
export interface TotpSetup {
  /** Base32 key for typing into the app by hand. */
  secret: string;
  otpauthUrl: string;
}

/**
 * A second factor was turned on. `recoveryCodes` holds a fresh set, shown once (only hashes are
 * kept), when the user had no unused codes; otherwise null.
 */
export interface TwoFactorEnabled {
  user: PublicUser;
  recoveryCodes: string[] | null;
}
