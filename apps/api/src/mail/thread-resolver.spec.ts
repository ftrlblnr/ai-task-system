/* eslint-disable @typescript-eslint/require-await -- in-memory индекс: async ради совместимости с интерфейсом ThreadIndex */
import { normalizeSubject, resolveThread, type ThreadIndex } from './thread-resolver';

// Индекс в памяти: письма → тред. Проверяем правила связывания, не хранилище.
interface Msg {
  threadId: string;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  subject: string;
  participants: string[];
  at: Date;
}

function memoryIndex(messages: Msg[]): ThreadIndex {
  return {
    findThreadIdsByMessageIds: async (ids) => [...new Set(messages.filter((m) => m.messageId && ids.includes(m.messageId)).map((m) => m.threadId))],
    findThreadIdsReferencing: async (id) => [...new Set(messages.filter((m) => m.inReplyTo === id || m.references.includes(id)).map((m) => m.threadId))],
    findRecentThreadsBySubject: async (norm, since) => {
      const byThread = new Map<string, { participants: Set<string>; lastMessageAt: Date }>();
      for (const m of messages.filter((x) => normalizeSubject(x.subject) === norm && x.at >= since)) {
        const cur = byThread.get(m.threadId) ?? { participants: new Set<string>(), lastMessageAt: m.at };
        m.participants.forEach((p) => cur.participants.add(p));
        if (m.at > cur.lastMessageAt) cur.lastMessageAt = m.at;
        byThread.set(m.threadId, cur);
      }
      return [...byThread.entries()].map(([threadId, v]) => ({ threadId, ...v }));
    },
  };
}

const D = (s: string) => new Date(s);
const msg = (over: Partial<Msg>): Msg => ({ threadId: 't1', messageId: '<a@x>', inReplyTo: null, references: [], subject: 'Договор', participants: ['a@x.kz', 'boss@mail.ru'], at: D('2026-09-20T10:00:00Z'), ...over });
const input = (over: Record<string, unknown> = {}) => ({
  internetMessageId: '<new@x>',
  inReplyTo: null as string | null,
  references: [] as string[],
  subject: 'Договор',
  participants: ['a@x.kz', 'boss@mail.ru'],
  receivedAt: D('2026-09-21T10:00:00Z'),
  ...over,
});

describe('normalizeSubject', () => {
  it('убирает Re:/Fwd:/Ответ:/Пересл: и регистр', () => {
    expect(normalizeSubject('Re: RE: Fwd: Договор  поставки')).toBe('договор поставки');
    expect(normalizeSubject('Ответ: Пересл: Счёт')).toBe('счёт');
    expect(normalizeSubject(null)).toBe('');
  });
});

describe('resolveThread — по заголовкам Message-ID / In-Reply-To / References', () => {
  it('цепочка In-Reply-To: ответ попадает в тред родителя', async () => {
    const index = memoryIndex([msg({ messageId: '<parent@x>', threadId: 'T-parent' })]);

    const r = await resolveThread(input({ inReplyTo: '<parent@x>' }), index);

    expect(r).toEqual({ threadIds: ['T-parent'], strategy: 'headers' });
  });

  it('цепочка References: связь с любым предком из списка', async () => {
    const index = memoryIndex([msg({ messageId: '<root@x>', threadId: 'T-root' })]);

    const r = await resolveThread(input({ inReplyTo: '<missing@x>', references: ['<root@x>', '<missing@x>'] }), index);

    expect(r.threadIds).toEqual(['T-root']);
  });

  it('письма вразнобой: «ребёнок» пришёл раньше «родителя» — родитель находит тред ребёнка', async () => {
    const index = memoryIndex([msg({ messageId: '<child@x>', inReplyTo: '<parent@x>', threadId: 'T-child' })]);

    const r = await resolveThread(input({ internetMessageId: '<parent@x>' }), index);

    expect(r).toEqual({ threadIds: ['T-child'], strategy: 'headers' });
  });

  it('письмо связывает два ранее разных треда — возвращаются оба (вызывающий сливает)', async () => {
    const index = memoryIndex([msg({ messageId: '<p1@x>', threadId: 'T1' }), msg({ messageId: '<p2@x>', threadId: 'T2' })]);

    const r = await resolveThread(input({ inReplyTo: '<p1@x>', references: ['<p2@x>'] }), index);

    expect(r.threadIds.sort()).toEqual(['T1', 'T2']);
  });
});

describe('resolveThread — фолбэк по теме (только без заголовков связи)', () => {
  it('одинаковая тема + общий участник + недавно, заголовков нет → один тред', async () => {
    const index = memoryIndex([msg({ threadId: 'T1' })]);

    const r = await resolveThread(input(), index);

    expect(r).toEqual({ threadIds: ['T1'], strategy: 'subject' });
  });

  it('одинаковая тема, но НЕТ общих участников → не склеиваются (разные переписки)', async () => {
    const index = memoryIndex([msg({ threadId: 'T1', participants: ['other@y.kz', 'someone@z.kz'] })]);

    expect((await resolveThread(input(), index)).strategy).toBe('new');
  });

  it('одинаковая тема, но письмо старше 14 дней → не склеиваются', async () => {
    const index = memoryIndex([msg({ threadId: 'T1', at: D('2026-08-01T10:00:00Z') })]);

    expect((await resolveThread(input(), index)).strategy).toBe('new');
  });

  it('у письма ЕСТЬ заголовки связи, но родитель неизвестен — тема НЕ используется (не склеиваем по одной теме)', async () => {
    const index = memoryIndex([msg({ threadId: 'T1' })]);

    const r = await resolveThread(input({ inReplyTo: '<unknown@x>' }), index);

    expect(r).toEqual({ threadIds: [], strategy: 'new' });
  });

  it('пустая тема — фолбэк не применяется', async () => {
    const index = memoryIndex([msg({ threadId: 'T1', subject: '' })]);

    expect((await resolveThread(input({ subject: null }), index)).strategy).toBe('new');
  });
});
