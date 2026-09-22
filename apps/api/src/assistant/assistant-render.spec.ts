import { MessagePartType } from '@prisma/client';
import { buildAssistantParts } from './assistant-render';
import type { AssistantReplyResult } from './assistant-reply.service';

// Чистые функции — не трогают Anthropic/Prisma, только маппинг уже готового
// AssistantReplyResult в MessagePart[] (Stage 2 §16 — бэкенд-рендерер, не
// модель, решает форму карточки).
describe('buildAssistantParts (Stage 2 Phase C — бэкенд-рендерер)', () => {
  it('без вызовов инструментов — только один markdown-part', () => {
    const result: AssistantReplyResult = { text: 'Привет!', toolCalls: [] };
    const parts = buildAssistantParts(result);
    expect(parts).toEqual([{ type: MessagePartType.MARKDOWN, order: 0, data: { content: 'Привет!' } }]);
  });

  it('get_tasks — порядок tool_activity → markdown → task_card×N, order по возрастанию', () => {
    const result: AssistantReplyResult = {
      text: 'Вот ваши просроченные задачи.',
      toolCalls: [
        {
          name: 'get_tasks',
          result: {
            tool: 'get_tasks',
            totalCount: 2,
            items: [
              { taskId: 't1', title: 'A', status: 'IN_PROGRESS', dueDate: null, assignee: null },
              { taskId: 't2', title: 'B', status: 'NEW', dueDate: null, assignee: null },
            ],
          },
        },
      ],
    };
    const parts = buildAssistantParts(result);
    expect(parts.map((p) => p.type)).toEqual([
      MessagePartType.TOOL_ACTIVITY,
      MessagePartType.MARKDOWN,
      MessagePartType.TASK_CARD,
      MessagePartType.TASK_CARD,
    ]);
    expect(parts.map((p) => p.order)).toEqual([0, 1, 2, 3]);
    expect(parts[0].data).toEqual({ label: 'Проверил задачи: найдено 2' });
    expect(parts[2].data).toMatchObject({ taskId: 't1' });
    expect(parts[3].data).toMatchObject({ taskId: 't2' });
  });

  it('ошибка инструмента — tool_activity с безопасным текстом, без карточек', () => {
    const result: AssistantReplyResult = {
      text: 'Не удалось получить задачи.',
      toolCalls: [{ name: 'get_tasks', result: { tool: 'get_tasks', error: true, message: 'connection refused' } }],
    };
    const parts = buildAssistantParts(result);
    expect(parts.map((p) => p.type)).toEqual([MessagePartType.TOOL_ACTIVITY, MessagePartType.MARKDOWN]);
    expect(parts[0].data).toEqual({ label: 'Не удалось проверить задачи' });
  });

  it('get_events — event_card с реальными полями', () => {
    const result: AssistantReplyResult = {
      text: 'У вас одна встреча завтра.',
      toolCalls: [
        {
          name: 'get_events',
          result: {
            tool: 'get_events',
            totalCount: 1,
            items: [
              {
                eventId: 'e1',
                title: 'Синк по проекту',
                startAt: '2026-09-16T10:00:00.000Z',
                endAt: '2026-09-16T11:00:00.000Z',
                location: null,
                participants: [{ id: 'emp1', name: 'Азамат' }],
              },
            ],
          },
        },
      ],
    };
    const parts = buildAssistantParts(result);
    expect(parts.map((p) => p.type)).toEqual([MessagePartType.TOOL_ACTIVITY, MessagePartType.MARKDOWN, MessagePartType.EVENT_CARD]);
    expect(parts[2].data).toMatchObject({ eventId: 'e1', participants: [{ id: 'emp1', name: 'Азамат' }] });
  });

  it('export_tasks_xlsx (Stage 2, Phase G) — один FILE-part вместо карточек', () => {
    const result: AssistantReplyResult = {
      text: 'Вот файл с задачами.',
      toolCalls: [
        {
          name: 'export_tasks_xlsx',
          durationMs: 42,
          result: {
            tool: 'export_tasks_xlsx',
            totalCount: 15,
            file: { fileId: 'f1', name: 'Задачи (все) 2026-09-16.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: 4096 },
          },
        },
      ],
    };
    const parts = buildAssistantParts(result);
    expect(parts.map((p) => p.type)).toEqual([MessagePartType.TOOL_ACTIVITY, MessagePartType.MARKDOWN, MessagePartType.FILE]);
    expect(parts[0].data).toEqual({ label: 'Сформировал файл: Задачи (все) 2026-09-16.xlsx' });
    expect(parts[2].data).toEqual({ fileId: 'f1', name: 'Задачи (все) 2026-09-16.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: 4096 });
  });

  it('export_tasks_xlsx — ошибка получает свою формулировку, не переиспользует "Не удалось проверить задачи"', () => {
    const result: AssistantReplyResult = {
      text: 'Не удалось сформировать файл.',
      toolCalls: [{ name: 'export_tasks_xlsx', durationMs: 10, result: { tool: 'export_tasks_xlsx', error: true, message: 'EXPORT_FAILED: не удалось сформировать файл' } }],
    };
    const parts = buildAssistantParts(result);
    expect(parts.map((p) => p.type)).toEqual([MessagePartType.TOOL_ACTIVITY, MessagePartType.MARKDOWN]);
    expect(parts[0].data).toEqual({ label: 'Не удалось сформировать файл' });
  });

  // Stage 2, Phase K (внешний аудит 21.09.2026, "Assistant meeting/Plaud
  // tools") — намеренно НЕТ отдельного типа карточки под встречи (нет
  // MEETING_CARD/UI под неё, владелец ограничил Phase K сервером/
  // инструментами) — только tool_activity + markdown-ответ модели, без
  // дополнительных частей.
  it('инструменты встреч — tool_activity со своей формулировкой на каждый, без доп. карточек', () => {
    const result: AssistantReplyResult = {
      text: 'Нашёл 2 встречи про завод.',
      toolCalls: [
        { name: 'search_meetings', result: { tool: 'search_meetings', totalCount: 2, items: [] } },
        {
          name: 'get_meeting',
          result: { tool: 'get_meeting', meeting: { meetingId: 'm1', title: 'Встреча про завод', meetingDate: '2026-09-01T00:00:00.000Z', summary: 'Обсудили сроки' } },
        },
        { name: 'search_meeting_transcript', result: { tool: 'search_meeting_transcript', totalCount: 0, items: [] } },
      ],
    };

    const parts = buildAssistantParts(result);

    expect(parts.map((p) => p.type)).toEqual([
      MessagePartType.TOOL_ACTIVITY,
      MessagePartType.TOOL_ACTIVITY,
      MessagePartType.TOOL_ACTIVITY,
      MessagePartType.MARKDOWN,
    ]);
    expect(parts[0].data).toEqual({ label: 'Искал встречи: найдено 2' });
    expect(parts[1].data).toEqual({ label: 'Открыл встречу «Встреча про завод»' });
    expect(parts[2].data).toEqual({ label: 'Искал в транскриптах: найдено 0' });
  });

  it('ошибка любого из инструментов встреч — общая формулировка "Не удалось проверить встречи"', () => {
    const result: AssistantReplyResult = {
      text: 'Не удалось найти встречи.',
      toolCalls: [{ name: 'search_meetings', result: { tool: 'search_meetings', error: true, message: 'MEETING_LOOKUP_FAILED: не удалось найти встречи' } }],
    };

    const parts = buildAssistantParts(result);

    expect(parts[0].data).toEqual({ label: 'Не удалось проверить встречи' });
  });

  // Stage 2, Phase O — create_task_from_meeting, единственный write-tool.
  // РЕГРЕССИЯ: изначально это ветка была пропущена и в toolActivityLabel
  // (падало с TS2339 на build — totalCount не существует на этом
  // варианте), и в самом buildAssistantParts (TASK_CARD не строился
  // вообще, карточка с источником никогда не доходила бы до чата).
  it('create_task_from_meeting — tool_activity с названием задачи, TASK_CARD с source', () => {
    const result: AssistantReplyResult = {
      text: 'Готово, задача создана.',
      toolCalls: [
        {
          name: 'create_task_from_meeting',
          result: {
            tool: 'create_task_from_meeting',
            task: {
              taskId: 't1',
              title: 'Получить КП',
              status: 'NEW',
              dueDate: null,
              assignee: { id: 'e1', name: 'Жандос' },
              source: { meetingId: 'm1', meetingTitle: 'Автоматизация завода', meetingDate: '2026-09-21T10:00:00.000Z', timestamp: '1:05', context: 'Нужно запросить КП' },
            },
          },
        },
      ],
    };

    const parts = buildAssistantParts(result);

    expect(parts.map((p) => p.type)).toEqual([MessagePartType.TOOL_ACTIVITY, MessagePartType.MARKDOWN, MessagePartType.TASK_CARD]);
    expect(parts[0].data).toEqual({ label: 'Поставил задачу «Получить КП»' });
    expect(parts[2].data).toMatchObject({ taskId: 't1', source: { meetingTitle: 'Автоматизация завода', timestamp: '1:05' } });
  });

  it('create_task_from_meeting — ошибка (например, ASSIGNEE_AMBIGUOUS) отдаёт свой message как есть в tool_activity, без карточки', () => {
    const result: AssistantReplyResult = {
      text: 'Уточните, пожалуйста, кого вы имели в виду.',
      toolCalls: [
        {
          name: 'create_task_from_meeting',
          result: { tool: 'create_task_from_meeting', error: true, message: 'ASSIGNEE_AMBIGUOUS: не удалось однозначно определить исполнителя' },
        },
      ],
    };

    const parts = buildAssistantParts(result);

    expect(parts.map((p) => p.type)).toEqual([MessagePartType.TOOL_ACTIVITY, MessagePartType.MARKDOWN]);
    expect(parts[0].data).toEqual({ label: 'Не удалось проверить задачи' });
  });
});
