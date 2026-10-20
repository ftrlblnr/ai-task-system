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

  it('ANSWERED с задачей — исполнителю-автору «вам», со сроком', () => {
    const n = {
      id: 'n1',
      kind: 'ANSWERED',
      attemptCount: 0,
      recipientId: 'e1',
      request: {
        title: 'Согласовать бюджет',
        rejectionReason: null,
        resolution: 'Согласовано.',
        task: { title: 'Заказать оборудование', dueDate: new Date('2026-11-05T12:00:00Z'), assigneeId: 'e1', assignee: { fullName: 'Сотрудник 1' } },
      },
      recipient: { telegramId: '123' },
    } as any;
    expect(buildMessageText(n)).toBe(
      'Ответ руководителя по вопросу „Согласовать бюджет“:\nСогласовано.\n\nПоставлена задача вам: „Заказать оборудование“, срок 05.11.2026.',
    );
  });
});
