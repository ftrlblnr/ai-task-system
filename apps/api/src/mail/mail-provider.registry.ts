import { Injectable } from '@nestjs/common';
import type { MailProvider } from '@prisma/client';
import type { EmailProvider } from './providers/email-provider';
import { ImapMailProvider } from './providers/imap.provider';

// Единственное место, знающее соответствие «тип провайдера → реализация».
// Mail.ru и любой IMAP-сервер — одна реализация, отличаются только серверы
// (mail-servers.ts).
@Injectable()
export class MailProviderRegistry {
  constructor(private readonly imap: ImapMailProvider) {}

  get(provider: MailProvider): EmailProvider {
    switch (provider) {
      case 'MAIL_RU':
      case 'IMAP':
        return this.imap;
    }
  }
}
