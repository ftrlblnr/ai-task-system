import { formatItem, formatTime, type DigestItem } from './mail-digest.cron';

describe('formatTime', () => {
  it('переводит UTC в местное время Алматы (+5)', () => {
    expect(formatTime(new Date('2026-09-28T05:15:00.000Z'))).toBe('10:15');
  });

  it('null → пустая строка', () => {
    expect(formatTime(null)).toBe('');
  });
});

function item(overrides: Partial<DigestItem> = {}): DigestItem {
  return {
    subject: 'Тема',
    fromAddress: 'sender@example.com',
    fromName: 'Иван',
    receivedAt: new Date('2026-09-28T05:15:00.000Z'),
    analysis: null,
    ...overrides,
  };
}

describe('formatItem', () => {
  it('без анализа — только время/отправитель/тема, без бейджей', () => {
    const line = formatItem(item({ analysis: null }));
    expect(line).toBe('• 10:15 Иван — Тема');
  });

  it('status=FAILED — тоже без бейджей (не выдаём проваленный анализ за реальный)', () => {
    const line = formatItem(item({ analysis: { status: 'FAILED', summary: null, importance: null, category: null, needsReply: null, needsAction: null } }));
    expect(line).toBe('• 10:15 Иван — Тема');
  });

  it('CRITICAL + needsReply + needsAction — все три бейджа по порядку', () => {
    const line = formatItem(
      item({
        analysis: { status: 'COMPLETED', summary: 'Срочно нужно решение.', importance: 'CRITICAL', category: 'ACTION_REQUIRED', needsReply: true, needsAction: true },
      }),
    );
    expect(line).toBe('• 10:15 Иван — Тема [Критично, нужен ответ, нужно действие]: Срочно нужно решение.');
  });

  it('NORMAL/LOW — importance не показывается как бейдж (пустой label)', () => {
    const line = formatItem(item({ analysis: { status: 'COMPLETED', summary: 'Ок.', importance: 'LOW', category: 'NEWSLETTER', needsReply: false, needsAction: false } }));
    expect(line).toBe('• 10:15 Иван — Тема: Ок.');
  });

  it('без имени отправителя — используется адрес', () => {
    const line = formatItem(item({ fromName: null, fromAddress: 'boss@mail.ru' }));
    expect(line).toContain('boss@mail.ru');
  });

  it('без темы — «(без темы)»', () => {
    expect(formatItem(item({ subject: null }))).toContain('(без темы)');
  });
});
