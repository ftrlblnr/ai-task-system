import { deriveReplyStatus, type ThreadMessageState } from './reply-status';

const at = (h: number) => new Date(Date.UTC(2026, 8, 20, h));
const inc = (h: number, over: Partial<ThreadMessageState> = {}): ThreadMessageState => ({ at: at(h), isOutgoing: false, isAutomated: false, needsReply: true, ...over });
const out = (h: number): ThreadMessageState => ({ at: at(h), isOutgoing: true, isAutomated: false, needsReply: null });

describe('deriveReplyStatus (ТЗ разд. 12)', () => {
  it('только входящее и оно требует ответа → AWAITING_MY_REPLY', () => {
    expect(deriveReplyStatus([inc(1)])).toBe('AWAITING_MY_REPLY');
  });

  it('входящее, затем исходящее → REPLIED', () => {
    expect(deriveReplyStatus([inc(1), out(2)])).toBe('REPLIED');
  });

  it('входящее → исходящее → НОВОЕ входящее: переоценка, снова ждёт моего ответа', () => {
    expect(deriveReplyStatus([inc(1), out(2), inc(3)])).toBe('AWAITING_MY_REPLY');
  });

  it('информационное письмо (needsReply=false) → NO_REPLY_REQUIRED', () => {
    expect(deriveReplyStatus([inc(1, { needsReply: false })])).toBe('NO_REPLY_REQUIRED');
  });

  it('рассылка/автоматика → NO_REPLY_REQUIRED независимо от анализа', () => {
    expect(deriveReplyStatus([inc(1, { isAutomated: true, needsReply: true })])).toBe('NO_REPLY_REQUIRED');
  });

  it('входящее ещё не проанализировано → UNKNOWN', () => {
    expect(deriveReplyStatus([inc(1, { needsReply: null })])).toBe('UNKNOWN');
  });

  it('мы написали первыми и ответа нет → AWAITING_THEIR_REPLY', () => {
    expect(deriveReplyStatus([out(1)])).toBe('AWAITING_THEIR_REPLY');
  });

  it('порядок сообщений на входе не важен — считается по времени', () => {
    expect(deriveReplyStatus([out(2), inc(1)])).toBe('REPLIED');
  });

  it('пустой тред → UNKNOWN', () => {
    expect(deriveReplyStatus([])).toBe('UNKNOWN');
  });
});
