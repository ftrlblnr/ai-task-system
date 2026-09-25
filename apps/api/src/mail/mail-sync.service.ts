import { Injectable, Logger } from '@nestjs/common';
import { EmailFolderRole } from '@prisma/client';
import { SecretBoxService } from '../crypto/secret-box.service';
import { MailStore, type MailboxRecord, type StoredFolder } from './mail-store';
import { MailProviderRegistry } from './mail-provider.registry';
import { MailConnectError, type EmailSession, type NormalizedMessage } from './providers/email-provider';
import { normalizeSubject, resolveThread } from './thread-resolver';

const DAY_MS = 24 * 60 * 60 * 1000;
export const SYNC_BATCH_SIZE = 50;
// Потолок одного прогона: начальная синхронизация большого ящика догоняется за
// несколько прогонов cron (курсор lastUid сохраняется после каждого батча), а не
// держит процесс/память 512 МБ и соединение с Mail.ru часами.
export const MAX_MESSAGES_PER_RUN = 300;
export const MAX_AUTH_FAILURES = 3;

export type SyncOutcome =
  | { status: 'skipped'; reason: 'already-running' | 'disabled' | 'not-found' }
  | { status: 'ok'; fetched: number; created: number }
  | { status: 'error'; code: string };

// Stage 2, Phase R — синхронизация одного ящика: Inbox + Sent, идемпотентно
// (unique(folderId, uid), повтор не плодит дубли), начальная (initialDays) +
// инкрементальная (uid > lastUid), обновление прочитанности, письма, пропавшие с
// сервера, помечаются providerMissing (не удаляются физически).
@Injectable()
export class MailSyncService {
  private readonly logger = new Logger(MailSyncService.name);
  // Один синк на ящик одновременно (cron 10 мин + ручной запуск + начальный после connect).
  private readonly running = new Set<string>();

  constructor(
    private readonly store: MailStore,
    private readonly secretBox: SecretBoxService,
    private readonly registry: MailProviderRegistry,
  ) {}

  async syncMailbox(mailboxId: string): Promise<SyncOutcome> {
    if (this.running.has(mailboxId)) return { status: 'skipped', reason: 'already-running' };
    this.running.add(mailboxId);
    const startedAt = Date.now();
    let session: EmailSession | null = null;
    try {
      const mailbox = await this.store.getMailbox(mailboxId);
      if (!mailbox) return { status: 'skipped', reason: 'not-found' };
      if (!mailbox.syncEnabled || mailbox.syncState === 'PAUSED') return { status: 'skipped', reason: 'disabled' };

      await this.store.patchMailbox(mailboxId, { syncState: 'SYNCING' });

      try {
        session = await this.registry.get(mailbox.provider).openSession({
          emailAddress: mailbox.emailAddress,
          appPassword: this.secretBox.decrypt(mailbox.appPasswordEncrypted),
        });
      } catch (err) {
        return await this.handleConnectFailure(mailbox, err);
      }

      const folders = await session.folders();
      const ordered = [...folders].sort((a, b) => (a.role === 'INBOX' ? -1 : b.role === 'INBOX' ? 1 : 0));
      let budget = MAX_MESSAGES_PER_RUN;
      let fetched = 0;
      let created = 0;
      const touchedThreads = new Set<string>();

      for (const f of ordered) {
        const folder = await this.store.upsertFolder(mailbox.id, f.path, f.role === 'INBOX' ? EmailFolderRole.INBOX : EmailFolderRole.SENT);
        const result = await this.syncFolder(session, mailbox, folder, budget, touchedThreads);
        budget -= result.fetched;
        fetched += result.fetched;
        created += result.created;
      }

      for (const threadId of touchedThreads) await this.store.refreshThread(threadId);

      await this.store.patchMailbox(mailboxId, { syncState: 'IDLE', lastError: null, lastSyncedAt: new Date(), consecutiveAuthFailures: 0 });
      // Без адресов/тем/текстов писем — только счётчики (правило voice-логов).
      this.logger.log(`mail sync mailbox=${mailboxId} fetched=${fetched} created=${created} durationMs=${Date.now() - startedAt}`);
      return { status: 'ok', fetched, created };
    } catch (err) {
      // Непредвиденный сбой середины синка (сеть/БД) — не пауза: следующий прогон
      // продолжит с сохранённого курсора.
      this.logger.error(`mail sync failed mailbox=${mailboxId}: ${err instanceof Error ? err.name : 'unknown'}`);
      await this.store.patchMailbox(mailboxId, { syncState: 'ERROR', lastError: 'SYNC_FAILED' }).catch(() => undefined);
      return { status: 'error', code: 'SYNC_FAILED' };
    } finally {
      await session?.close();
      this.running.delete(mailboxId);
    }
  }

  private async handleConnectFailure(mailbox: MailboxRecord, err: unknown): Promise<SyncOutcome> {
    const code = err instanceof MailConnectError ? err.code : 'UNKNOWN';
    const authProblem = code === 'INVALID_CREDENTIALS' || code === 'IMAP_DISABLED';
    const failures = authProblem ? mailbox.consecutiveAuthFailures + 1 : mailbox.consecutiveAuthFailures;
    // Несколько подряд отказов авторизации → пауза: не долбим Mail.ru неверным
    // паролем (риск блокировки). Владелец переподключает ящик в UI.
    const paused = authProblem && failures >= MAX_AUTH_FAILURES;
    await this.store.patchMailbox(mailbox.id, {
      syncState: paused ? 'PAUSED' : 'ERROR',
      lastError: code,
      consecutiveAuthFailures: failures,
    });
    this.logger.warn(`mail connect failed mailbox=${mailbox.id} code=${code} paused=${paused}`);
    return { status: 'error', code };
  }

  private async syncFolder(
    session: EmailSession,
    mailbox: MailboxRecord,
    folder: StoredFolder,
    budget: number,
    touchedThreads: Set<string>,
  ): Promise<{ fetched: number; created: number }> {
    const opened = await session.openFolder(folder.path);
    let lastUid = folder.lastUid;
    let uidValidityReset = false;

    if (folder.uidValidity !== opened.uidValidity) {
      // Сервер перенумеровал UID (или первая синхронизация) — курсор недействителен.
      uidValidityReset = folder.uidValidity !== null;
      lastUid = 0;
      await this.store.updateFolder(folder.id, { uidValidity: opened.uidValidity, lastUid: 0 });
    }

    const since = new Date(Date.now() - mailbox.initialDays * DAY_MS);
    let fetched = 0;
    let created = 0;

    while (budget - fetched > 0) {
      const batch = await session.fetchNew(folder.path, lastUid, lastUid === 0 ? since : null, Math.min(SYNC_BATCH_SIZE, budget - fetched));
      if (batch.length === 0) break;
      for (const message of batch) {
        if (await this.storeMessage(mailbox, folder, message, touchedThreads)) created++;
      }
      fetched += batch.length;
      lastUid = Math.max(lastUid, ...batch.map((m) => m.uid));
      // Курсор — после каждого батча: обрыв посреди синка не теряет прогресс.
      await this.store.updateFolder(folder.id, { lastUid });
      if (batch.length < SYNC_BATCH_SIZE) break;
    }

    // После смены UIDVALIDITY локальные UID недостоверны — сверку флагов пропускаем.
    if (!uidValidityReset) await this.reconcileFlags(session, folder, since, touchedThreads);
    return { fetched, created };
  }

  // true — письмо создано, false — уже было (идемпотентность).
  private async storeMessage(mailbox: MailboxRecord, folder: StoredFolder, m: NormalizedMessage, touchedThreads: Set<string>): Promise<boolean> {
    const existing = await this.store.findMessageByUid(folder.id, m.uid);
    if (existing) {
      if (existing.isRead !== m.isRead) await this.store.setMessageRead(existing.id, m.isRead);
      return false;
    }
    if (m.internetMessageId) {
      const duplicate = await this.store.findMessageByInternetId(folder.id, m.internetMessageId);
      if (duplicate) {
        await this.store.setMessageUid(duplicate.id, m.uid);
        return false;
      }
    }

    const threadId = await this.assignThread(mailbox, m);
    const id = await this.store.createMessage({
      mailboxId: mailbox.id,
      folderId: folder.id,
      isOutgoing: folder.role === EmailFolderRole.SENT,
      threadId,
      message: m,
    });
    touchedThreads.add(threadId);
    return id !== null;
  }

  private async assignThread(mailbox: MailboxRecord, m: NormalizedMessage): Promise<string> {
    const own = mailbox.emailAddress.toLowerCase();
    // Свой адрес есть в каждом треде — из участников исключаем, иначе фолбэк по
    // теме склеивал бы все письма «с моим участием».
    const participants = [m.from.address, ...m.to.map((a) => a.address), ...m.cc.map((a) => a.address)].filter((a) => a !== own);
    const resolution = await resolveThread(
      {
        internetMessageId: m.internetMessageId,
        inReplyTo: m.inReplyTo,
        references: m.references,
        subject: m.subject,
        participants,
        receivedAt: m.receivedAt ?? m.sentAt ?? new Date(),
      },
      this.store.threadIndex(mailbox.id),
    );
    if (resolution.threadIds.length === 0) return (await this.store.createThread(mailbox.id, normalizeSubject(m.subject))).id;
    const [keep, ...others] = resolution.threadIds;
    await this.store.mergeThreads(keep, others);
    return keep;
  }

  // Флаги «прочитано» за окно синхронизации + письма, исчезнувшие на сервере.
  private async reconcileFlags(session: EmailSession, folder: StoredFolder, since: Date, touchedThreads: Set<string>): Promise<void> {
    const fromUid = await this.store.minUidSince(folder.id, since);
    if (fromUid === null) return;
    const remote = await session.fetchFlagsFrom(folder.path, fromUid);
    const local = await this.store.listLocalFrom(folder.id, fromUid);
    // Пустой ответ при непустой локальной базе — скорее сбой, чем «всё удалено»:
    // массово не помечаем пропавшими.
    if (remote.size === 0 && local.length > 0) return;

    const missing: string[] = [];
    const present: string[] = [];
    for (const l of local) {
      const isRead = remote.get(l.uid);
      if (isRead === undefined) {
        if (!l.providerMissing) missing.push(l.id);
        continue;
      }
      if (l.providerMissing) present.push(l.id);
      if (l.isRead !== isRead) await this.store.setMessageRead(l.id, isRead);
    }
    await this.store.setMissing(missing, true);
    await this.store.setMissing(present, false);
    for (const threadId of await this.store.touchedThreadsOfMessages([...missing, ...present])) touchedThreads.add(threadId);
  }
}
