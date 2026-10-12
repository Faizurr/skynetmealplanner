import nodemailer from 'nodemailer';
import type { Config } from './config.js';

export interface OutgoingEmail {
  to: string[];
  subject: string;
  text: string;
  html: string;
  idempotencyKey: string;
}

export interface Mailer {
  readonly name: string;
  send(msg: OutgoingEmail): Promise<{ messageId: string | null }>;
}

class SmtpMailer implements Mailer {
  readonly name = 'smtp';
  private transport;
  constructor(private cfg: Config) {
    this.transport = nodemailer.createTransport({
      host: cfg.SMTP_HOST,
      port: cfg.SMTP_PORT ?? 587,
      secure: cfg.SMTP_SECURE ?? cfg.SMTP_PORT === 465,
      ignoreTLS: cfg.SMTP_IGNORE_TLS,
      auth: cfg.SMTP_USER ? { user: cfg.SMTP_USER, pass: cfg.SMTP_PASS } : undefined,
      connectionTimeout: 15_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
  }
  async send(msg: OutgoingEmail) {
    const info = await this.transport.sendMail({
      from: this.cfg.EMAIL_FROM,
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
      headers: { 'X-Entity-Ref-ID': msg.idempotencyKey },
    });
    return { messageId: info.messageId ?? null };
  }
}

/** Resend HTTP API (https://resend.com). Uses its Idempotency-Key header to avoid duplicates on retry. */
class ResendMailer implements Mailer {
  readonly name = 'resend';
  constructor(private cfg: Config) {}
  async send(msg: OutgoingEmail) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.cfg.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': msg.idempotencyKey.slice(0, 256),
      },
      body: JSON.stringify({ from: this.cfg.EMAIL_FROM, to: msg.to, subject: msg.subject, text: msg.text, html: msg.html }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
    if (!res.ok) throw new Error(`resend ${res.status}: ${body.message ?? 'request failed'}`);
    return { messageId: body.id ?? null };
  }
}

/** Development transport: writes the email to stdout and reports it as delivered locally. */
class LogMailer implements Mailer {
  readonly name = 'log';
  async send(msg: OutgoingEmail) {
    console.log(`[mail:log] to=${msg.to.join(',')} subject="${msg.subject}"\n${msg.text}\n`);
    return { messageId: `log-${msg.idempotencyKey}` };
  }
}

export function createMailer(cfg: Config): Mailer | null {
  switch (cfg.EMAIL_TRANSPORT) {
    case 'smtp': return new SmtpMailer(cfg);
    case 'resend': return new ResendMailer(cfg);
    case 'log': return new LogMailer();
    case 'disabled': return null;
  }
}
