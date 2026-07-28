import { logger } from '../logger.js';

export interface MailerOptions {
  enabled: boolean;
  from: string;
  transport?: 'console' | 'smtp';
  smtp?: {
    host: string;
    port: number;
    auth?: { user: string; pass: string };
    secure?: boolean;
  };
}

export interface MailPayload {
  to: string;
  subject: string;
  text: string;
}

let mailerOptions: MailerOptions = {
  enabled: process.env.MAILER_ENABLED === 'true',
  from: process.env.MAILER_FROM ?? 'noreply@callora.com',
  transport: (process.env.MAILER_TRANSPORT as 'console' | 'smtp') ?? 'console',
};

export function configureMailer(options: Partial<MailerOptions>): void {
  mailerOptions = { ...mailerOptions, ...options };
}

export async function sendMail(payload: MailPayload): Promise<void> {
  if (!mailerOptions.enabled) {
    logger.info('[mailer] Mailer disabled, skipping email', { to: payload.to, subject: payload.subject });
    return;
  }

  logger.info('[mailer] Sending email', {
    to: payload.to,
    subject: payload.subject,
    transport: mailerOptions.transport,
  });

  if (mailerOptions.transport === 'smtp') {
    let nodemailer: any;
    try {
      nodemailer = await import('nodemailer');
    } catch {
      logger.warn('[mailer] nodemailer not installed, falling back to console transport');
      logToConsole(payload);
      return;
    }
    const transporter = nodemailer.createTransport({
      host: mailerOptions.smtp?.host ?? 'localhost',
      port: mailerOptions.smtp?.port ?? 587,
      secure: mailerOptions.smtp?.secure ?? false,
      auth: mailerOptions.smtp?.auth,
    });
    await transporter.sendMail({
      from: mailerOptions.from,
      to: payload.to,
      subject: payload.subject,
      text: payload.text,
    });
    return;
  }

  logToConsole(payload);
}

function logToConsole(payload: MailPayload): void {
  logger.info('[mailer] Email notification', {
    from: mailerOptions.from,
    to: payload.to,
    subject: payload.subject,
    body: payload.text,
  });
}
