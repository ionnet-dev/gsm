import { z } from "zod";
import { ROLES } from "@gsm/shared";
import { Password } from "../auth/schemas.ts";

export const CreateUserBody = z.object({
  email: z.string().email().max(255),
  name: z.string().min(1).max(120),
  password: Password,
  role: z.enum(ROLES).default("user"),
});

export const UpdateUserBody = z.object({
  name: z.string().min(1).max(120).optional(),
  role: z.enum(ROLES).optional(),
  disabled: z.boolean().optional(),
  /** Administrators may only turn 2FA off (to recover a locked-out user); users enable it themselves. */
  twoFactorEnabled: z.literal(false).optional(),
});

export const ResetPasswordBody = z.object({ password: Password });
