import nodemailer from "nodemailer";
import { badRequest } from "./errors.ts";
import { getGeneral, getSmtp } from "../modules/settings/service.ts";

export async function sendMail(
  to: string | string[],
  subject: string,
  text: string,
  html?: string,
): Promise<void> {
  const smtp = await getSmtp();
  if (!smtp.host || !smtp.from) throw badRequest("SMTP is not configured (Settings → General)");
  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: smtp.user ? { user: smtp.user, pass: smtp.password } : undefined,
    connectionTimeout: 10_000,
  });
  await transport.sendMail({ from: smtp.from, to, subject, text, html });
}

export async function sendTestEmail(to: string): Promise<void> {
  const general = await getGeneral();
  await sendMail(
    to,
    `[${general.siteName}] Test email`,
    "SMTP is configured correctly for Ionnet GSM.",
  );
}
