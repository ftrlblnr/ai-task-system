import type { MailProvider } from '@prisma/client';
import type { MailCredentials } from './providers/email-provider';

// Серверы ящика (владелец 23.10.2026: кроме Mail.ru — корпоративная почта
// на своём сервере). Для MAIL_RU — фиксированный пресет, для IMAP — то, что
// ввёл пользователь при подключении.

export interface MailServerSettings {
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
}

export const MAIL_RU_SERVERS: MailServerSettings = {
  imapHost: 'imap.mail.ru',
  imapPort: 993,
  imapSecure: true,
  smtpHost: 'smtp.mail.ru',
  smtpPort: 465,
  smtpSecure: true,
};

// Владелец 23.10.2026 — ящиков может быть несколько: выбранный в интерфейсе
// передаётся заголовком X-Mailbox-Id (без него — первый подключённый).
export const MAILBOX_HEADER = 'x-mailbox-id';

export const PROVIDER_LABELS: Record<MailProvider, string> = {
  MAIL_RU: 'Mail.ru',
  IMAP: 'Почта',
};

export interface MailboxServerFields extends MailServerSettings {
  emailAddress: string;
  login: string | null;
}

export function credentialsFor(mailbox: MailboxServerFields, password: string): MailCredentials {
  return {
    emailAddress: mailbox.emailAddress,
    appPassword: password,
    login: mailbox.login || mailbox.emailAddress,
    imap: { host: mailbox.imapHost, port: mailbox.imapPort, secure: mailbox.imapSecure },
  };
}
