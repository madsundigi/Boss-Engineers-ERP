export interface EmailAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
}
export interface EmailMessage {
  to: string;
  cc?: string;
  subject: string;
  text: string;
  attachments?: EmailAttachment[];
}
export interface SentResult {
  messageId: string;
  to: string;
}

/** Transport port — swap the adapter without touching business code. */
export interface EmailTransport {
  send(msg: EmailMessage): Promise<SentResult>;
}

/**
 * Dev/test transport: records messages in an in-memory outbox instead of
 * hitting an SMTP server. Lets tests assert that an email (with the PDF
 * attachment) was composed and "sent".
 */
export class OutboxTransport implements EmailTransport {
  public readonly outbox: (EmailMessage & SentResult)[] = [];
  async send(msg: EmailMessage): Promise<SentResult> {
    const messageId = `outbox-${this.outbox.length + 1}-${Date.now()}@boss-erp.local`;
    this.outbox.push({ ...msg, messageId, to: msg.to });
    return { messageId, to: msg.to };
  }
}

/**
 * Production transport: nodemailer over SMTP. Loaded lazily so the dependency
 * is only required when SMTP is actually configured.
 */
export class SmtpTransport implements EmailTransport {
  constructor(private readonly smtpUrl: string, private readonly from: string) {}
  async send(msg: EmailMessage): Promise<SentResult> {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport(this.smtpUrl);
    const info = await transporter.sendMail({
      from: this.from, to: msg.to, cc: msg.cc, subject: msg.subject, text: msg.text,
      attachments: msg.attachments?.map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType })),
    });
    return { messageId: info.messageId, to: msg.to };
  }
}

export class EmailService {
  constructor(private readonly transport: EmailTransport) {}
  send(msg: EmailMessage): Promise<SentResult> {
    return this.transport.send(msg);
  }
}

/** Pick a transport from the environment (SMTP if configured, else outbox). */
export function buildEmailTransport(): EmailTransport {
  const url = process.env.SMTP_URL;
  if (url) return new SmtpTransport(url, process.env.MAIL_FROM ?? 'no-reply@boss-erp.local');
  return new OutboxTransport();
}
