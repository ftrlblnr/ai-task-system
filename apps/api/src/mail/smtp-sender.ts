import { Injectable } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';
import type { MailServerSettings } from './mail-servers';
import { MailConnectError } from './providers/email-provider';

// Отправка писем по SMTP (владелец 23.10.2026). Пароль — тот же, что для
// IMAP (у Mail.ru — пароль приложения). Логгер nodemailer выключен — иначе
// в лог попал бы AUTH.

export interface SmtpAuth {
  login: string;
  password: string;
}

function mapSmtpError(err: unknown): MailConnectError {
  const e = err as { code?: string; responseCode?: number; message?: string };
  const text = `${e?.code ?? ''} ${e?.message ?? ''}`;
  if (e?.code === 'EAUTH' || e?.responseCode === 535) return new MailConnectError('INVALID_CREDENTIALS');
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|DEPTH_ZERO|altnames|certificate/i.test(text)) return new MailConnectError('TLS_ERROR');
  if (/ETIMEDOUT|ECONNECTION|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ESOCKET|timeout/i.test(text)) return new MailConnectError('TIMEOUT');
  return new MailConnectError('UNKNOWN');
}

export class SmtpRejectedError extends Error {
  constructor() {
    super('SMTP_REJECTED');
    this.name = 'SmtpRejectedError';
  }
}

@Injectable()
export class SmtpSender {
  private transport(server: MailServerSettings, auth: SmtpAuth): Transporter {
    return createTransport({
      host: server.smtpHost,
      port: server.smtpPort,
      // secure=false — STARTTLS (порт 587); требуем шифрование, открытым текстом пароль не уходит.
      secure: server.smtpSecure,
      requireTLS: !server.smtpSecure,
      auth: { user: auth.login, pass: auth.password },
      connectionTimeout: 20_000,
      greetingTimeout: 20_000,
      socketTimeout: 60_000,
      logger: false,
      debug: false,
    });
  }

  // Отправка готового письма (raw — RFC 822 без Bcc). Возвращает принятые и
  // отклонённые сервером адреса; ошибка соединения/входа — MailConnectError.
  async send(server: MailServerSettings, auth: SmtpAuth, envelope: { from: string; to: string[] }, raw: Buffer): Promise<{ accepted: string[]; rejected: string[] }> {
    const transport = this.transport(server, auth);
    try {
      const info = (await transport.sendMail({ envelope, raw })) as { accepted?: unknown[]; rejected?: unknown[] };
      const list = (v: unknown[] | undefined) => (v ?? []).map((x) => (typeof x === 'string' ? x : String((x as { address?: string }).address ?? ''))).filter(Boolean);
      return { accepted: list(info.accepted), rejected: list(info.rejected) };
    } catch (err) {
      const e = err as { code?: string; rejected?: unknown[] };
      // Сервер отклонил всех получателей — это не сбой соединения.
      if (e?.code === 'EENVELOPE') throw new SmtpRejectedError();
      throw mapSmtpError(err);
    } finally {
      transport.close();
    }
  }

  // Проверка входа на SMTP-сервер при подключении ящика.
  async verify(server: MailServerSettings, auth: SmtpAuth): Promise<void> {
    const transport = this.transport(server, auth);
    try {
      await transport.verify();
    } catch (err) {
      throw mapSmtpError(err);
    } finally {
      transport.close();
    }
  }
}
