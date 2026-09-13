import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AuthStatus,
  LoginResult,
  PublicUser,
  SecondFactor,
  TotpSetup,
  TwoFactorChallenge,
  TwoFactorEnabled,
  TwoFactorMethod,
  TwoFactorStatus,
} from "@gsm/shared";
import { get, post } from "./client";

export const authStatusQuery = queryOptions({
  queryKey: ["auth", "status"],
  queryFn: () => get<AuthStatus>("/auth/status"),
  staleTime: 60_000,
});

export function useAuth() {
  const q = useQuery(authStatusQuery);
  const user = q.data?.user ?? null;
  return {
    ...q,
    user,
    admin: user?.role === "admin",
    setupRequired: q.data?.setupRequired ?? false,
    emailCodesAvailable: q.data?.emailCodesAvailable ?? false,
    passwordResetAvailable: q.data?.passwordResetAvailable ?? false,
  };
}

function useSignedIn() {
  const qc = useQueryClient();
  // Write the new user straight into the cache: route guards read it synchronously right after.
  return (user: PublicUser) =>
    qc.setQueryData<AuthStatus>(authStatusQuery.queryKey, (prev) => ({
      setupRequired: false,
      user,
      emailCodesAvailable: prev?.emailCodesAvailable ?? false,
      passwordResetAvailable: prev?.passwordResetAvailable ?? false,
    }));
}

/** Drop every cached query and record that nobody is signed in. */
function useSignedOut() {
  const qc = useQueryClient();
  return () => {
    const prev = qc.getQueryData<AuthStatus>(authStatusQuery.queryKey);
    qc.clear();
    qc.setQueryData<AuthStatus>(authStatusQuery.queryKey, {
      setupRequired: false,
      user: null,
      emailCodesAvailable: false,
      passwordResetAvailable: prev?.passwordResetAvailable ?? false,
    });
  };
}

export function useLogin() {
  const signedIn = useSignedIn();
  return useMutation({
    mutationFn: (body: { email: string; password: string }) =>
      post<LoginResult>("/auth/login", body),
    onSuccess: (res) => {
      if (!res.twoFactorRequired) signedIn(res.user);
    },
  });
}

export function useVerifyLogin() {
  const signedIn = useSignedIn();
  return useMutation({
    mutationFn: (body: { challengeId: string; code: string; method: SecondFactor }) =>
      post<{ user: PublicUser }>("/auth/login/verify", body),
    onSuccess: ({ user }) => signedIn(user),
  });
}

/** Sends the email code for a login challenge, or a new one if it was already sent. */
export function useResendLoginCode() {
  return useMutation({
    mutationFn: (challengeId: string) =>
      post<TwoFactorChallenge>("/auth/login/resend", { challengeId }),
  });
}

export function useSetup() {
  const signedIn = useSignedIn();
  return useMutation({
    mutationFn: (body: { email: string; name: string; password: string }) =>
      post<{ user: PublicUser }>("/auth/setup", body),
    onSuccess: ({ user }) => signedIn(user),
  });
}

export function useLogout() {
  const signedOut = useSignedOut();
  return useMutation({
    mutationFn: () => post<{ ok: true }>("/auth/logout"),
    onSuccess: signedOut,
  });
}

export function useChangePassword() {
  return useMutation({
    mutationFn: (body: { currentPassword: string; newPassword: string }) =>
      post<{ ok: true }>("/auth/password", body),
  });
}

/** "Forgot password?": emails a reset link. Succeeds whether or not the address has an account. */
export function useForgotPassword() {
  return useMutation({
    mutationFn: (email: string) => post<{ ok: true }>("/auth/password/forgot", { email }),
  });
}

/** Sets a new password from an emailed link. The server ends every session, this one included. */
export function useResetPassword() {
  const signedOut = useSignedOut();
  return useMutation({
    mutationFn: (body: { token: string; newPassword: string }) =>
      post<{ ok: true }>("/auth/password/reset", body),
    onSuccess: signedOut,
  });
}

export const useTwoFactorStatus = () =>
  useQuery({ queryKey: ["auth", "2fa"], queryFn: () => get<TwoFactorStatus>("/auth/2fa") });

/** Turning second factors on and off, and replacing recovery codes, for the signed-in user. */
export function useTwoFactor() {
  const qc = useQueryClient();
  const refresh = ({ user }: { user: PublicUser }) => {
    qc.setQueryData<AuthStatus>(
      authStatusQuery.queryKey,
      (prev) => prev ? { ...prev, user } : prev,
    );
    qc.invalidateQueries({ queryKey: ["auth"] });
  };
  return {
    emailStart: useMutation({
      mutationFn: () => post<TwoFactorChallenge>("/auth/2fa/enable/start"),
    }),
    emailResend: useMutation({
      mutationFn: (challengeId: string) =>
        post<TwoFactorChallenge>("/auth/2fa/enable/resend", { challengeId }),
    }),
    emailConfirm: useMutation({
      mutationFn: (body: { challengeId: string; code: string }) =>
        post<TwoFactorEnabled>("/auth/2fa/enable/confirm", body),
      onSuccess: refresh,
    }),
    totpStart: useMutation({
      mutationFn: (password: string) => post<TotpSetup>("/auth/2fa/totp/start", { password }),
    }),
    totpConfirm: useMutation({
      mutationFn: (code: string) => post<TwoFactorEnabled>("/auth/2fa/totp/confirm", { code }),
      onSuccess: refresh,
    }),
    disable: useMutation({
      mutationFn: (body: { method: TwoFactorMethod; password: string }) =>
        post<{ user: PublicUser }>("/auth/2fa/disable", body),
      onSuccess: refresh,
    }),
    regenerate: useMutation({
      mutationFn: (password: string) =>
        post<{ recoveryCodes: string[] }>("/auth/2fa/recovery-codes", { password }),
      onSuccess: () => qc.invalidateQueries({ queryKey: ["auth", "2fa"] }),
    }),
  };
}
