import { buildMessageText } from './reception-notifications.cron';

function notification(overrides: { kind: 'CALLED' | 'REJECTED' | 'RETURNED_TO_QUEUE'; rejectionReason?: string | null }) {
  return {
    id: 'n1',
    kind: overrides.kind,
    attemptCount: 0,
    request: { title: 'Согласовать бюджет', rejectionReason: overrides.rejectionReason ?? null },
    recipient: { telegramId: '123' },
  } as any;
}

describe('buildMessageText (раздел 10.1 ТЗ — тексты уведомлений дословно)', () => {
  it('CALLED', () => {
    expect(buildMessageText(notification({ kind: 'CALLED' }))).toBe('Руководитель приглашает вас по вопросу „Согласовать бюджет“. Подойдите к ней.');
  });

  it('REJECTED без причины', () => {
    expect(buildMessageText(notification({ kind: 'REJECTED' }))).toBe('Ваше обращение „Согласовать бюджет“ отклонено.');
  });

  it('REJECTED с причиной', () => {
    expect(buildMessageText(notification({ kind: 'REJECTED', rejectionReason: 'Сначала согласуйте бюджет с финансовым отделом.' }))).toBe(
      'Ваше обращение „Согласовать бюджет“ отклонено. Причина: Сначала согласуйте бюджет с финансовым отделом.',
    );
  });

  it('RETURNED_TO_QUEUE', () => {
    expect(buildMessageText(notification({ kind: 'RETURNED_TO_QUEUE' }))).toBe(
      'Вызов по вопросу „Согласовать бюджет“ отменён. Вопрос возвращён в очередь; ожидайте нового вызова.',
    );
  });
});
