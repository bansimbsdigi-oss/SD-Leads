// Outgoing email over SMTP (Gmail / Google Workspace with an app password, or any SMTP server).
// Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS and MAIL_FROM. Without them, emails are only logged
// (fine for local development, where the reset link is printed to the server console).
import nodemailer from "nodemailer";
import { logger } from "@/lib/logger";

export const mailConfigured = () => Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);

let transport: nodemailer.Transporter | null = null;
function getTransport() {
  if (!transport) {
    const port = Number(process.env.SMTP_PORT || 465);
    transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: port === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  }
  return transport;
}

export async function sendMail(msg: { to: string; subject: string; text: string; html?: string }): Promise<boolean> {
  if (!mailConfigured()) {
    logger.warn({ to: msg.to, subject: msg.subject, text: msg.text }, "email not sent: SMTP is not configured");
    return false;
  }
  try {
    await getTransport().sendMail({ from: process.env.MAIL_FROM || process.env.SMTP_USER, ...msg });
    return true;
  } catch (err) {
    logger.error({ err, to: msg.to, subject: msg.subject }, "email failed");
    return false;
  }
}
