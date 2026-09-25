/* eslint-disable @typescript-eslint/require-await -- in-memory fake хранилища/провайдера: методы async ради совместимости интерфейса */
import { EmailFolderRole } from '@prisma/client';
import { MailSyncService, MAX_AUTH_FAILURES, MAX_MESSAGES_PER_RUN } from './mail-sync.service';
import { MailConnectError, type NormalizedMessage, type ProviderFolder } from './providers/email-provider';
import { deriveReplyStatus } from './reply-status';
import type { ThreadIndex } from './thread-resolver';
import { normalizeSubject } from './thread-resolver';

// ---- In-memory MailStore: те же методы, что использует MailSyncService ----
interface StoredMsg {
  id: string;
  folderId: string;
  uid: number;
  isRead: boolean;
  isOutgoing: boolean;
  isAutomated: boolean;
  internetMessageId: string | null;
  inReplyTo: string | null;
  references: string[];
  subject: string | null;
  participants: string[];
  at: Date;
  threadId: string;
  providerMissing: boolean;
}

class FakeStore {
  mailbox: any = { id: 'mb1', employeeId: 'e1', provider: 'MAIL_RU', emailAddress: 'boss@mail.ru', appPasswordEncrypted: 'ENC', syncEnabled: true, syncState: 'IDLE', consecutiveAuthFailures: 0, initialDays: 30 };
  mailboxPatches: any[] = [];
  folders: { id: string; path: string; role: EmailFolderRole; uidValidity: string | null; lastUid: number }[] = [];
  messages: StoredMsg[] = [];
  threads = new Map<string, { subjectNorm: string; replyStatus: string; lastMessageAt: Date | null }>();
  seq = 0;

  async getMailbox() {
    return this.mailbox;
  }
  async patchMailbox(_id: string, patch: any) {
    this.mailboxPatches.push(patch);
    Object.assign(this.mailbox, patch);
  }
  async upsertFolder(_mb: string, path: string, role: EmailFolderRole) {
    let f = this.folders.find((x) => x.path === path);
    if (!f) {
      f = { id: `f${++this.seq}`, path, role, uidValidity: null, lastUid: 0 };
      this.folders.push(f);
    }
    return { ...f };
  }
  async updateFolder(id: string, patch: any) {
    Object.assign(this.folders.find((f) => f.id === id)!, patch);
  }
  async findMessageByUid(folderId: string, uid: number) {
    return this.messages.find((m) => m.folderId === folderId && m.uid === uid) ?? null;
  }
  async findMessageByInternetId(folderId: string, id: string) {
    return this.messages.find((m) => m.folderId === folderId && m.internetMessageId === id) ?? null;
  }
  async setMessageUid(id: string, uid: number) {
    const m = this.messages.find((x) => x.id === id)!;
    m.uid = uid;
    m.providerMissing = false;
  }
  async setMessageRead(id: string, isRead: boolean) {
    this.messages.find((x) => x.id === id)!.isRead = isRead;
  }
  async createMessage(r: any) {
    const m = r.message as NormalizedMessage;
    if (this.messages.some((x) => x.folderId === r.folderId && x.uid === m.uid)) return null;
    const id = `m${++this.seq}`;
    this.messages.push({
      id,
      folderId: r.folderId,
      uid: m.uid,
      isRead: m.isRead,
      isOutgoing: r.isOutgoing,
      isAutomated: m.isAutomated,
      internetMessageId: m.internetMessageId,
      inReplyTo: m.inReplyTo,
      references: m.references,
      subject: m.subject,
      participants: [m.from.address, ...m.to.map((a) => a.address), ...m.cc.map((a) => a.address)],
      at: m.receivedAt ?? new Date(),
      threadId: r.threadId,
      providerMissing: false,
    });
    return id;
  }
  async createThread(_mb: string, subjectNorm: string) {
    const id = `t${++this.seq}`;
    this.threads.set(id, { subjectNorm, replyStatus: 'UNKNOWN', lastMessageAt: null });
    return { id };
  }
  async mergeThreads(keep: string, others: string[]) {
    for (const m of this.messages) if (others.includes(m.threadId)) m.threadId = keep;
    for (const o of others) this.threads.delete(o);
  }
  async refreshThread(threadId: string) {
    const msgs = this.messages.filter((m) => m.threadId === threadId && !m.providerMissing);
    const t = this.threads.get(threadId);
    if (!t) return;
    t.replyStatus = deriveReplyStatus(msgs.map((m) => ({ at: m.at, isOutgoing: m.isOutgoing, isAutomated: m.isAutomated, needsReply: null })));
    t.lastMessageAt = msgs.length ? new Date(Math.max(...msgs.map((m) => m.at.getTime()))) : null;
  }
  threadIndex(): ThreadIndex {
    return {
      findThreadIdsByMessageIds: async (ids) => [...new Set(this.messages.filter((m) => m.internetMessageId && ids.includes(m.internetMessageId)).map((m) => m.threadId))],
      findThreadIdsReferencing: async (id) => [...new Set(this.messages.filter((m) => m.inReplyTo === id || m.references.includes(id)).map((m) => m.threadId))],
      findRecentThreadsBySubject: async (norm, since) => {
        const out: { threadId: string; lastMessageAt: Date; participants: Set<string> }[] = [];
        for (const [threadId, t] of this.threads) {
          if (t.subjectNorm !== norm || !t.lastMessageAt || t.lastMessageAt < since) continue;
          const msgs = this.messages.filter((m) => m.threadId === threadId);
          out.push({ threadId, lastMessageAt: t.lastMessageAt, participants: new Set(msgs.flatMap((m) => m.participants)) });
        }
        return out;
      },
    };
  }
  async minUidSince(folderId: string, since: Date) {
    const uids = this.messages.filter((m) => m.folderId === folderId && m.at >= since).map((m) => m.uid);
    return uids.length ? Math.min(...uids) : null;
  }
  async listLocalFrom(folderId: string, fromUid: number) {
    return this.messages.filter((m) => m.folderId === folderId && m.uid >= fromUid).map((m) => ({ id: m.id, uid: m.uid, isRead: m.isRead, providerMissing: m.providerMissing }));
  }
  async setMissing(ids: string[], missing: boolean) {
    for (const m of this.messages) if (ids.includes(m.id)) m.providerMissing = missing;
  }
  async touchedThreadsOfMessages(ids: string[]) {
    return [...new Set(this.messages.filter((m) => ids.includes(m.id)).map((m) => m.threadId))];
  }
}

// ---- Fake провайдера: «сервер» с двумя папками ----
interface RemoteMsg {
  uid: number;
  messageId: string;
  subject: string;
  from: string;
  to: string;
  receivedAt: Date;
  isRead?: boolean;
  inReplyTo?: string;
  references?: string[];
  automated?: boolean;
}

class FakeServer {
  inbox: RemoteMsg[] = [];
  sent: RemoteMsg[] = [];
  uidValidity = { INBOX: '1', Sent: '1' } as Record<string, string>;
  failConnect: MailConnectError | null = null;
  emptyFlags = false;
  folders: ProviderFolder[] = [
    { path: 'INBOX', role: 'INBOX' },
    { path: 'Sent', role: 'SENT' },
  ];
  connects = 0;

  private list(path: string) {
    return path === 'INBOX' ? this.inbox : this.sent;
  }
  private toNormalized(m: RemoteMsg): NormalizedMessage {
    return {
      uid: m.uid,
      internetMessageId: m.messageId,
      subject: m.subject,
      from: { address: m.from },
      to: [{ address: m.to }],
      cc: [],
      bcc: [],
      sentAt: m.receivedAt,
      receivedAt: m.receivedAt,
      textBody: 'текст',
      htmlBody: null,
      bodyTruncated: false,
      isRead: m.isRead ?? false,
      hasAttachments: false,
      isAutomated: m.automated ?? false,
      inReplyTo: m.inReplyTo ?? null,
      references: m.references ?? [],
      attachments: [],
    };
  }
  provider = {
    openSession: async () => {
      this.connects++;
      if (this.failConnect) throw this.failConnect;
      return {
        folders: async () => this.folders,
        openFolder: async (path: string) => ({ uidValidity: this.uidValidity[path] }),
        fetchNew: async (path: string, afterUid: number, since: Date | null, limit: number) =>
          this.list(path)
            .filter((m) => m.uid > afterUid && (since === null || m.receivedAt >= since))
            .sort((a, b) => a.uid - b.uid)
            .slice(0, limit)
            .map((m) => this.toNormalized(m)),
        fetchFlagsFrom: async (path: string, fromUid: number) =>
          new Map<number, boolean>(this.emptyFlags ? [] : this.list(path).filter((m) => m.uid >= fromUid).map((m) => [m.uid, m.isRead ?? false] as [number, boolean])),
        close: async () => undefined,
      };
    },
  };
}

const NOW = Date.now();
const ago = (days: number) => new Date(NOW - days * 86_400_000);
const remote = (over: Partial<RemoteMsg> & { uid: number }): RemoteMsg => ({ messageId: `<m${over.uid}@x>`, subject: 'Тема', from: 'partner@idat.kz', to: 'boss@mail.ru', receivedAt: ago(1), ...over });

function setup() {
  const store = new FakeStore();
  const server = new FakeServer();
  const secretBox = { decrypt: jest.fn().mockReturnValue('app-password') };
  const registry = { get: () => server.provider };
  const service = new MailSyncService(store as any, secretBox as any, registry as any);
  return { store, server, service, secretBox };
}

describe('MailSyncService — Inbox и Sent', () => {
  it('начальная синхронизация: письма Inbox входящие, Sent — исходящие; пароль расшифровывается только для подключения', async () => {
    const { store, server, service, secretBox } = setup();
    server.inbox.push(remote({ uid: 1 }), remote({ uid: 2, subject: 'Другое', from: 'x@y.kz' }));
    server.sent.push(remote({ uid: 1, messageId: '<s1@x>', subject: 'Своё', from: 'boss@mail.ru', to: 'z@w.kz' }));

    const result = await service.syncMailbox('mb1');

    expect(result).toMatchObject({ status: 'ok', created: 3 });
    expect(store.messages.filter((m) => !m.isOutgoing)).toHaveLength(2);
    expect(store.messages.filter((m) => m.isOutgoing)).toHaveLength(1);
    expect(secretBox.decrypt).toHaveBeenCalledWith('ENC');
    expect(store.mailbox).toMatchObject({ syncState: 'IDLE', lastError: null });
  });

  it('ИДЕМПОТЕНТНОСТЬ: повторный синк тех же писем не создаёт дублей', async () => {
    const { store, server, service } = setup();
    server.inbox.push(remote({ uid: 1 }), remote({ uid: 2 }));
    server.sent.push(remote({ uid: 1, messageId: '<s1@x>', from: 'boss@mail.ru', to: 'p@x.kz' }));

    await service.syncMailbox('mb1');
    const second = await service.syncMailbox('mb1');

    expect(second).toMatchObject({ status: 'ok', created: 0 });
    expect(store.messages).toHaveLength(3);
  });

  it('инкрементально: новое письмо после курсора подхватывается, старые не перекачиваются', async () => {
    const { store, server, service } = setup();
    server.inbox.push(remote({ uid: 1 }));
    await service.syncMailbox('mb1');

    server.inbox.push(remote({ uid: 2 }));
    const second = await service.syncMailbox('mb1');

    expect(second).toMatchObject({ status: 'ok', fetched: 1, created: 1 });
    expect(store.folders.find((f) => f.path === 'INBOX')!.lastUid).toBe(2);
  });

  it('входящее → мой ответ в Sent: тред REPLIED (Sent обязателен для определения ответа)', async () => {
    const { store, server, service } = setup();
    server.inbox.push(remote({ uid: 1, messageId: '<q@x>', subject: 'Вопрос', receivedAt: ago(2) }));
    await service.syncMailbox('mb1');
    expect([...store.threads.values()][0].replyStatus).toBe('UNKNOWN'); // без анализа входящее — не определено

    server.sent.push(remote({ uid: 1, messageId: '<a@x>', subject: 'Re: Вопрос', from: 'boss@mail.ru', to: 'partner@idat.kz', inReplyTo: '<q@x>', receivedAt: ago(1) }));
    await service.syncMailbox('mb1');

    expect(store.threads.size).toBe(1);
    expect([...store.threads.values()][0].replyStatus).toBe('REPLIED');
  });

  it('рассылка по заголовкам → NO_REPLY_REQUIRED без анализа', async () => {
    const { store, server, service } = setup();
    server.inbox.push(remote({ uid: 1, automated: true, from: 'noreply@shop.com' }));

    await service.syncMailbox('mb1');

    expect([...store.threads.values()][0].replyStatus).toBe('NO_REPLY_REQUIRED');
  });

  it('несвязанные письма с одной темой и разными участниками — разные треды', async () => {
    const { store, server, service } = setup();
    server.inbox.push(remote({ uid: 1, subject: 'Счёт', from: 'a@one.kz' }), remote({ uid: 2, subject: 'Счёт', from: 'b@two.kz' }));

    await service.syncMailbox('mb1');

    expect(store.threads.size).toBe(2);
  });
});

describe('MailSyncService — флаги, исчезнувшие письма, UIDVALIDITY', () => {
  it('прочитанность обновляется по флагам сервера', async () => {
    const { store, server, service } = setup();
    server.inbox.push(remote({ uid: 1, isRead: false }));
    await service.syncMailbox('mb1');
    expect(store.messages[0].isRead).toBe(false);

    server.inbox[0].isRead = true;
    await service.syncMailbox('mb1');

    expect(store.messages[0].isRead).toBe(true);
  });

  it('письмо исчезло на сервере — providerMissing, физически не удаляется; вернулось — снова доступно', async () => {
    const { store, server, service } = setup();
    server.inbox.push(remote({ uid: 1 }), remote({ uid: 2 }));
    await service.syncMailbox('mb1');

    server.inbox = server.inbox.filter((m) => m.uid !== 1);
    await service.syncMailbox('mb1');
    expect(store.messages.find((m) => m.uid === 1)!.providerMissing).toBe(true);
    expect(store.messages).toHaveLength(2);

    server.inbox.push(remote({ uid: 1 }));
    await service.syncMailbox('mb1');
    expect(store.messages.find((m) => m.uid === 1)!.providerMissing).toBe(false);
  });

  it('пустой ответ по флагам при непустой базе — не помечаем ВСЁ пропавшим (защита от сбоя)', async () => {
    const { store, server, service } = setup();
    server.inbox.push(remote({ uid: 1 }), remote({ uid: 2 }));
    await service.syncMailbox('mb1');

    server.emptyFlags = true;
    await service.syncMailbox('mb1');

    expect(store.messages.every((m) => !m.providerMissing)).toBe(true);
  });

  it('смена UIDVALIDITY: письма пере-нумерованы, дублей нет (сопоставление по Message-ID)', async () => {
    const { store, server, service } = setup();
    server.inbox.push(remote({ uid: 1, messageId: '<a@x>' }), remote({ uid: 2, messageId: '<b@x>' }));
    await service.syncMailbox('mb1');

    server.uidValidity.INBOX = '2';
    server.inbox = [remote({ uid: 101, messageId: '<a@x>' }), remote({ uid: 102, messageId: '<b@x>' }), remote({ uid: 103, messageId: '<c@x>' })];
    await service.syncMailbox('mb1');

    expect(store.messages.filter((m) => !m.isOutgoing)).toHaveLength(3);
    expect(store.messages.find((m) => m.internetMessageId === '<a@x>')!.uid).toBe(101);
  });
});

describe('MailSyncService — ошибки подключения и защита', () => {
  it('неверный пароль: ERROR + счётчик; после MAX_AUTH_FAILURES подряд — PAUSED и дальше не пытается', async () => {
    const { store, server, service } = setup();
    server.failConnect = new MailConnectError('INVALID_CREDENTIALS');

    for (let i = 0; i < MAX_AUTH_FAILURES; i++) await service.syncMailbox('mb1');

    expect(store.mailbox).toMatchObject({ syncState: 'PAUSED', lastError: 'INVALID_CREDENTIALS', consecutiveAuthFailures: MAX_AUTH_FAILURES });
    const connectsBefore = server.connects;
    const skipped = await service.syncMailbox('mb1');
    expect(skipped).toMatchObject({ status: 'skipped', reason: 'disabled' });
    expect(server.connects).toBe(connectsBefore);
  });

  it('таймаут сети — ERROR, но НЕ пауза и счётчик auth не растёт; следующий прогон восстанавливается', async () => {
    const { store, server, service } = setup();
    server.inbox.push(remote({ uid: 1 }));
    server.failConnect = new MailConnectError('TIMEOUT');

    await service.syncMailbox('mb1');
    expect(store.mailbox).toMatchObject({ syncState: 'ERROR', lastError: 'TIMEOUT', consecutiveAuthFailures: 0 });

    server.failConnect = null;
    const ok = await service.syncMailbox('mb1');
    expect(ok.status).toBe('ok');
    expect(store.mailbox).toMatchObject({ syncState: 'IDLE', lastError: null });
  });

  it('IMAP выключен — тоже считается отказом авторизации и ведёт к паузе', async () => {
    const { store, server, service } = setup();
    server.failConnect = new MailConnectError('IMAP_DISABLED');

    for (let i = 0; i < MAX_AUTH_FAILURES; i++) await service.syncMailbox('mb1');

    expect(store.mailbox.syncState).toBe('PAUSED');
  });

  it('два синка одного ящика одновременно — второй пропускается (один синк на ящик)', async () => {
    const { server, service } = setup();
    server.inbox.push(remote({ uid: 1 }));

    const [a, b] = await Promise.all([service.syncMailbox('mb1'), service.syncMailbox('mb1')]);

    expect([a.status, b.status].sort()).toEqual(['ok', 'skipped']);
  });

  it('потолок прогона: большой ящик догоняется за несколько прогонов, прогресс сохраняется', async () => {
    const { store, server, service } = setup();
    for (let uid = 1; uid <= MAX_MESSAGES_PER_RUN + 50; uid++) server.inbox.push(remote({ uid }));

    const first = await service.syncMailbox('mb1');
    expect(first).toMatchObject({ status: 'ok', fetched: MAX_MESSAGES_PER_RUN });

    const second = await service.syncMailbox('mb1');
    expect(second).toMatchObject({ status: 'ok', fetched: 50 });
    expect(store.messages).toHaveLength(MAX_MESSAGES_PER_RUN + 50);
  });

  it('отключённый ящик не синхронизируется', async () => {
    const { store, service, server } = setup();
    store.mailbox.syncEnabled = false;

    expect(await service.syncMailbox('mb1')).toMatchObject({ status: 'skipped', reason: 'disabled' });
    expect(server.connects).toBe(0);
  });
});

it('normalizeSubject используется тредами (sanity)', () => {
  expect(normalizeSubject('Re: Тема')).toBe('тема');
});
