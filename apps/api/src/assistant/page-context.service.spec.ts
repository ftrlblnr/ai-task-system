/* eslint-disable @typescript-eslint/require-await -- моки сервисов асинхронные по контракту настоящих */
import { NotFoundException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { PageContextService } from './page-context.service';
import { serializeCurrentUserTurn } from './assistant-chat.service';
import { stripLeakedContextMarkers } from './assistant-reply.service';
import type { AuthenticatedUser } from '../auth/jwt.strategy';

// Редизайн web W2 — контекст страницы для панели агента: id из клиента —
// только подсказка, чужое/несуществующее в контекст не попадает.

const owner = { id: 'owner-1', role: Role.OWNER } as AuthenticatedUser;
const employee = { id: 'emp-1', role: Role.EMPLOYEE } as AuthenticatedUser;

function build() {
  const tasks = {
    findOne: jest.fn(async (id: string) => {
      if (id !== 'task-1') throw new NotFoundException('Задача не найдена');
      return {
        id: 'task-1',
        title: 'Подготовить смету',
        status: 'IN_PROGRESS',
        priority: 'HIGH',
        assignee: { fullName: 'Иван Петров' },
        creator: { fullName: 'Руководитель' },
        dueDate: new Date('2026-11-05T13:00:00Z'),
        subtaskCount: 2,
        subtaskDoneCount: 1,
        parentTask: null,
        description: 'Смета по объекту Береке',
      };
    }),
  };
  const events = {
    findOne: jest.fn(async (id: string, ownerId: string) => {
      if (id !== 'event-1' || ownerId !== 'owner-1')
        throw new NotFoundException('Событие не найдено');
      return {
        id: 'event-1',
        title: 'Планёрка',
        startAt: new Date('2026-10-27T04:00:00Z'),
        endAt: new Date('2026-10-27T05:00:00Z'),
        location: null,
        participants: [],
        description: null,
      };
    }),
  };
  const meetings = {
    findOne: jest.fn(async () => ({
      id: 'm-1',
      title: 'Встреча',
      meetingDate: new Date(),
      enhancedSummary: null,
      latestSummary: null,
      rawSummary: 'Итоги',
    })),
  };
  const mailStore = {
    listMailboxesByEmployee: jest.fn(async (employeeId: string) =>
      employeeId === 'owner-1' ? [{ id: 'box-own' }] : [],
    ),
  };
  const mailQuery = {
    getMessage: jest.fn(async (mailboxIds: string[], id: string) => {
      if (id !== 'mail-1' || !mailboxIds.includes('box-own'))
        throw new NotFoundException('Письмо не найдено');
      return {
        id: 'mail-1',
        subject: 'Счёт',
        fromName: null,
        fromAddress: 'b@corp.kz',
        receivedAt: new Date(),
        textBody: 'Оплатите счёт',
        analysis: {
          summary: 'Просят оплатить',
          needsReply: true,
          actionSummary: null,
        },
      };
    }),
  };
  const audit = { log: jest.fn(async () => undefined) };
  const service = new PageContextService(
    tasks as never,
    events as never,
    meetings as never,
    mailQuery as never,
    mailStore as never,
    audit as never,
  );
  return { service, tasks, events, meetings, mailQuery, mailStore, audit };
}

describe('PageContextService', () => {
  it('задача — краткая сводка с id', async () => {
    const { service } = build();
    const text = await service.describe(employee, {
      kind: 'task',
      id: 'task-1',
    });
    expect(text).toContain('id: task-1');
    expect(text).toContain('Подготовить смету');
    expect(text).toContain('Иван Петров');
  });

  it('несуществующая задача — контекста нет', async () => {
    const { service } = build();
    await expect(
      service.describe(owner, { kind: 'task', id: 'nope' }),
    ).resolves.toBeNull();
  });

  it('чужое событие календаря — контекста нет', async () => {
    const { service, events } = build();
    await expect(
      service.describe(
        { id: 'owner-2', role: Role.OWNER } as AuthenticatedUser,
        { kind: 'event', id: 'event-1' },
      ),
    ).resolves.toBeNull();
    expect(events.findOne).toHaveBeenCalledWith('event-1', 'owner-2');
  });

  it('своё событие — в контексте', async () => {
    const { service } = build();
    await expect(
      service.describe(owner, { kind: 'event', id: 'event-1' }),
    ).resolves.toContain('Планёрка');
  });

  it('письмо из чужого ящика — контекста нет', async () => {
    const { service, audit } = build();
    await expect(
      service.describe(owner, { kind: 'mail', id: 'mail-of-other-box' }),
    ).resolves.toBeNull();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('своё письмо — в контексте, чтение пишется в аудит', async () => {
    const { service, audit } = build();
    const text = await service.describe(owner, { kind: 'mail', id: 'mail-1' });
    expect(text).toContain('Просят оплатить');
    expect(audit.log).toHaveBeenCalledWith(
      'owner-1',
      'AI_MAIL_READ',
      'EmailMessage',
      'mail-1',
      { source: 'page_context' },
    );
  });

  it('сотруднику почта, встречи и календарь в контекст не попадают — сервисы даже не вызываются', async () => {
    const { service, mailStore, meetings, events } = build();
    await expect(
      service.describe(employee, { kind: 'mail', id: 'mail-1' }),
    ).resolves.toBeNull();
    await expect(
      service.describe(employee, { kind: 'meeting', id: 'm-1' }),
    ).resolves.toBeNull();
    await expect(
      service.describe(employee, { kind: 'event', id: 'event-1' }),
    ).resolves.toBeNull();
    expect(mailStore.listMailboxesByEmployee).not.toHaveBeenCalled();
    expect(meetings.findOne).not.toHaveBeenCalled();
    expect(events.findOne).not.toHaveBeenCalled();
  });

  it('пульт — только руководителю; неизвестный раздел — пусто', async () => {
    const { service } = build();
    await expect(
      service.describe(owner, { kind: 'dashboard' }),
    ).resolves.toContain('Пульт');
    await expect(
      service.describe(employee, { kind: 'dashboard' }),
    ).resolves.toBeNull();
    await expect(
      service.describe(owner, { kind: 'list', route: '/admin-secret' }),
    ).resolves.toBeNull();
    await expect(
      service.describe(owner, {
        kind: 'list',
        route: '/tasks',
        filter: 'просроченные',
      }),
    ).resolves.toContain('Фильтр: просроченные');
  });

  it('без контекста — null', async () => {
    const { service } = build();
    await expect(service.describe(owner, undefined)).resolves.toBeNull();
  });
});

describe('[page_context] в текущем ходе', () => {
  it('идёт отдельным блоком перед текстом, сам текст не меняется', () => {
    const turn = serializeCurrentUserTurn(
      'Напомни исполнителю',
      [],
      undefined,
      'Пользователь смотрит задачу.\nid: task-1',
    );
    expect(turn).toBe(
      '[page_context]\nПользователь смотрит задачу.\nid: task-1\n[/page_context]\n\nНапомни исполнителю',
    );
  });

  it('пустой контекст не добавляется', () => {
    expect(serializeCurrentUserTurn('Привет', [], undefined, null)).toBe(
      'Привет',
    );
  });

  it('маркер не утекает в ответ', () => {
    expect(
      stripLeakedContextMarkers(
        'Готово.\n[page_context]\nid: task-1\n[/page_context]',
      ),
    ).toBe('Готово.');
  });
});
