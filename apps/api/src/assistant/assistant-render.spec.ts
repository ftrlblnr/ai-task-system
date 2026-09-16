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
});
