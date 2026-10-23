import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import type { EmailFolderRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MailActionSessionFactory } from './action/mail-action-session-factory';
import { MailStore } from './mail-store';
import { MailSyncService } from './mail-sync.service';
import { StaleLocatorError, type EmailSession, type MessageLocator } from './providers/email-provider';

// Действия над письмами из почтового клиента (владелец 23.10.2026: «весь
// важный функционал, как в Outlook»). Сначала живьём на сервере (IMAP),
// потом та же правка в БД — список в интерфейсе меняется сразу, без ожидания
// синка. Это действия самого пользователя в интерфейсе; действия ассистента
// идут через план с подтверждением (action/).

export type MessageAction =
  | { type: 'read'; value: boolean }
  | { type: 'flag'; value: boolean }
  | { type: 'move'; folderId: string }
  | { type: 'archive' }
  | { type: 'trash' }
  // Навсегда (из «Корзины»/«Спама»): UID EXPUNGE ровно этого письма.
  | { type: 'delete' };

export interface MessageActionResult {
  done: string[];
  failed: { id: string; error: string }[];
}

export const MAX_MESSAGES_PER_ACTION = 200;

const ROLE_FOR_ACTION: Partial<Record<MessageAction['type'], EmailFolderRole>> = { archive: 'ARCHIVE', trash: 'TRASH' };
const MISSING_FOLDER_TEXT: Partial<Record<EmailFolderRole, string>> = {
  ARCHIVE: 'В ящике нет папки «Архив» — переместите письмо в нужную папку',
  TRASH: 'В ящике нет папки «Корзина»',
};
// Сервер без папки с ролью \Archive (корпоративный shark.kz, 23.10.2026):
// архивом считается папка «Archive»/«Архив» — её создаёт план ассистента
// (assistant-mail-actions.ts) по подтверждению или сам пользователь.
export function isArchiveFolderName(path: string): boolean {
  return /^(archive|архив)$/i.test(path.split(/[/.]/).pop() ?? '');
}

const STALE_TEXT = 'Письмо изменилось на сервере — список обновляется, повторите действие';

interface TargetMessage {
  id: string;
  mailboxId: string;
  uid: number;
  threadId: string | null;
  folder: { id: string; path: string; role: EmailFolderRole; uidValidity: string | null };
}

@Injectable()
export class MailMessageActionsService {
  private readonly logger = new Logger(MailMessageActionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: MailActionSessionFactory,
    private readonly store: MailStore,
    private readonly sync: MailSyncService,
  ) {}

  async apply(mailboxId: string, messageIds: string[], action: MessageAction): Promise<MessageActionResult> {
    const ids = [...new Set(messageIds)];
    if (ids.length === 0) throw new BadRequestException('Не выбраны письма');
    if (ids.length > MAX_MESSAGES_PER_ACTION) throw new BadRequestException(`За раз — не больше ${MAX_MESSAGES_PER_ACTION} писем`);

    const messages: TargetMessage[] = await this.prisma.emailMessage.findMany({
      where: { id: { in: ids }, mailboxId, providerMissing: false },
      select: { id: true, mailboxId: true, uid: true, threadId: true, folder: { select: { id: true, path: true, role: true, uidValidity: true } } },
    });
    const result: MessageActionResult = { done: [], failed: ids.filter((id) => !messages.some((m) => m.id === id)).map((id) => ({ id, error: 'Письмо не найдено' })) };
    if (messages.length === 0) return result;

    const target = await this.resolveTarget(mailboxId, action);
    if (typeof target === 'string') {
      result.failed.push(...messages.map((m) => ({ id: m.id, error: target })));
      return result;
    }

    const session = await this.sessions.openSession(mailboxId);
    let stale = false;
    try {
      for (const m of messages) {
        try {
          await this.applyOne(session, m, action, target);
          result.done.push(m.id);
        } catch (err) {
          if (err instanceof StaleLocatorError) stale = true;
          result.failed.push({ id: m.id, error: this.errorText(err) });
        }
      }
    } finally {
      await session.close().catch(() => undefined);
    }

    const threads = new Set(messages.map((m) => m.threadId).filter((t): t is string => Boolean(t)));
    for (const threadId of threads) await this.store.refreshThread(threadId).catch(() => undefined);
    // Перемещённые без UIDPLUS и устаревшие координаты догонит синк.
    if (stale || action.type === 'move' || action.type === 'archive' || action.type === 'trash') {
      void this.sync.syncMailbox(mailboxId).catch(() => undefined);
    }
    this.logger.log(`mail action mailbox=${mailboxId} type=${action.type} done=${result.done.length} failed=${result.failed.length}`);
    return result;
  }

  // Папка назначения для move/archive/trash; строка — понятная ошибка.
  private async resolveTarget(mailboxId: string, action: MessageAction): Promise<{ id: string; path: string; uidValidity: string | null } | null | string> {
    if (action.type === 'move') {
      const folder = await this.prisma.emailFolder.findFirst({ where: { id: action.folderId, mailboxId, lastSeenAt: { not: null } }, select: { id: true, path: true, uidValidity: true } });
      return folder ?? 'Папка не найдена';
    }
    const role = ROLE_FOR_ACTION[action.type];
    if (!role) return null;
    const folder = await this.prisma.emailFolder.findFirst({ where: { mailboxId, role, lastSeenAt: { not: null } }, select: { id: true, path: true, uidValidity: true } });
    if (folder) return folder;
    if (role === 'ARCHIVE') {
      const others = await this.prisma.emailFolder.findMany({ where: { mailboxId, role: 'OTHER', lastSeenAt: { not: null } }, select: { id: true, path: true, uidValidity: true } });
      const named = others.find((f) => isArchiveFolderName(f.path));
      if (named) return named;
    }
    return MISSING_FOLDER_TEXT[role] as string;
  }

  private async applyOne(session: EmailSession, m: TargetMessage, action: MessageAction, target: { id: string; path: string; uidValidity: string | null } | null): Promise<void> {
    if (!m.folder.uidValidity) throw new BadRequestException('Папка ещё не синхронизирована');
    const locator: MessageLocator = { folderPath: m.folder.path, uidValidity: m.folder.uidValidity, uid: m.uid };

    switch (action.type) {
      case 'read':
        await session.changeFlag(locator, '\\Seen', action.value);
        await this.store.setMessageFlags(m.id, { isRead: action.value });
        return;
      case 'flag':
        await session.changeFlag(locator, '\\Flagged', action.value);
        await this.store.setMessageFlags(m.id, { isFlagged: action.value });
        return;
      case 'delete':
        if (m.folder.role !== 'TRASH' && m.folder.role !== 'JUNK') throw new BadRequestException('Навсегда удаляются только письма из «Корзины» или «Спама»');
        await session.deleteMessage(locator);
        await this.store.setMissing([m.id], true);
        return;
      default: {
        if (!target || target.id === m.folder.id) return;
        const moved = await session.moveMessage(locator, target.path);
        await this.relocate(m.id, target, moved.newUid, moved.newUidValidity);
      }
    }
  }

  // Новые координаты известны (UIDPLUS) и UIDVALIDITY папки совпадает — письмо
  // переносится в БД сразу; иначе старая запись помечается пропавшей, а в
  // папке назначения письмо появится при синке.
  private async relocate(id: string, target: { id: string; uidValidity: string | null }, newUid: number | null, newUidValidity: string | null): Promise<void> {
    if (newUid !== null && target.uidValidity !== null && newUidValidity === target.uidValidity) {
      try {
        await this.prisma.emailMessage.update({ where: { id }, data: { folderId: target.id, uid: newUid, providerMissing: false, deletedAt: null } });
        return;
      } catch {
        // Синк уже успел завести письмо в папке назначения (unique folderId+uid).
      }
    }
    await this.store.setMissing([id], true);
  }

  private errorText(err: unknown): string {
    if (err instanceof StaleLocatorError) return STALE_TEXT;
    if (err instanceof BadRequestException) return err.message;
    // Тексты провайдера (без MOVE/UIDPLUS) — свои, безопасные; остальное не раскрываем.
    if (err instanceof Error && /недоступно|не выполнено/.test(err.message)) return err.message;
    this.logger.warn(`mail action failed: ${err instanceof Error ? err.name : 'unknown'}`);
    return 'Сервер почты не выполнил действие, попробуйте ещё раз';
  }
}
