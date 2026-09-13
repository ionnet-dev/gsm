import { z } from "zod";
import { SECOND_FACTORS, TWO_FACTOR_METHODS } from "@gsm/shared";

export const Password = z.string().min(10, "Password must be at least 10 characters").max(200);

export const LoginBody = z.object({
  email: z.string().email().max(255),
  password: z.string().min(1).max(200),
});

export const SetupBody = z.object({
  email: z.string().email().max(255),
  name: z.string().min(1).max(120),
  password: Password,
});

export const ChangePasswordBody = z.object({
  currentPassword: z.string().min(1),
  newPassword: Password,
});

export const ForgotPasswordBody = z.object({ email: z.string().email().max(255) });

/** The token from the emailed link (see password-reset.ts). */
export const ResetPasswordBody = z.object({
  token: z.string().min(1).max(128),
  newPassword: Password,
});

export const ChallengeRef = z.object({ challengeId: z.string().min(1).max(64) });

export const VerifyCodeBody = ChallengeRef.extend({
  code: z.string().min(1).max(32),
  /** Which factor the code is for; when omitted it is guessed from the code's shape. */
  method: z.enum(SECOND_FACTORS).optional(),
});

/** Re-entering the password for sensitive 2FA changes. */
export const PasswordBody = z.object({ password: z.string().min(1).max(200) });

export const DisableTwoFactorBody = PasswordBody.extend({ method: z.enum(TWO_FACTOR_METHODS) });

export const TotpConfirmBody = z.object({ code: z.string().min(1).max(16) });
