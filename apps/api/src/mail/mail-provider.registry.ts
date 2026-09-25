import { Injectable } from '@nestjs/common';
import type { MailProvider } from '@prisma/client';
import type { EmailProvider } from './providers/email-provider';
import { MailRuImapProvider } from './providers/mailru-imap.provider';

// Единственное место, знающее соответствие «тип провайдера → реализация».
// Microsoft365/Gmail/произвольный IMAP добавляются сюда, бизнес-логика не меняется.
@Injectable()
export class MailProviderRegistry {
  constructor(private readonly mailRu: MailRuImapProvider) {}

  get(provider: MailProvider): EmailProvider {
    switch (provider) {
      case 'MAIL_RU':
        return this.mailRu;
    }
  }
}
