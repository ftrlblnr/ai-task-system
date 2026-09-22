import { MessagePartType } from '@prisma/client';
import { buildVoiceAssistantParts, resolveClarificationReason } from './voice-render';
import type { ExecutedVoiceAction, TaskCardEntity, EventCardEntity } from './voice.service';
import type { VoiceTaskActionDraft, VoiceEventActionDraft } from './dto/voice-draft-response.dto';

// Чистая функция — не трогает Prisma/Tasks/Events, только маппинг уже
// выполненных execResults (Stage 2, Phase H) в MessagePart[], тот же приём,
// что buildAssistantParts (assistant-render.spec.ts) для текстового чата.

function taskDraft(overrides: Partial<VoiceTaskActionDraft> = {}): VoiceTaskActionDraft {
  return {
    type: 'task_action',
    action: 'create',
    targetTaskId: '',
    targetTitle: 'Задача',
    title: 'Задача',
    description: '',
    assigneeId: null,
    assigneeName: null,
    assigneeMentioned: false,
    assigneeRawText: '',
    dueDate: null,
    priority: null,
    sourceMeetingId: null,
    ...overrides,
  };
}

function eventDraft(overrides: Partial<VoiceEventActionDraft> = {}): VoiceEventActionDraft {
  return {
    type: 'event_action',
    action: 'create',
    targetEventId: '',
    targetTitle: 'Встреча',
    title: 'Встреча',
    description: '',
    location: '',
    startAt: '2026-09-15T15:00:00+05:00',
    endAt: null,
    allDay: null,
    addParticipantIds: [],
    addParticipantNames: [],
    removeParticipantIds: [],
    removeParticipantNames: [],
    ...overrides,
  };
}

const taskEntity: TaskCardEntity = { id: 't1', title: 'Задача', status: 'NEW', dueDate: null, assignee: null };
const eventEntity: EventCardEntity = {
  id: 'e1',
  title: 'Встреча',
  startAt: new Date('2026-09-15T10:00:00.000Z'),
  endAt: new Date('2026-09-15T11:00:00.000Z'),
  location: null,
  participants: [],
};

describe('buildVoiceAssistantParts (Stage 2, Phase H)', () => {
  it('chat-черновик → один markdown-part', () => {
    const execResults: ExecutedVoiceAction[] = [{ result: { type: 'chat', reply: 'Не расслышал.' }, entity: null }];
    const parts = buildVoiceAssistantParts(execResults, null);
    expect(parts).toEqual([{ type: MessagePartType.MARKDOWN, order: 0, data: { content: 'Не расслышал.' } }]);
  });

  it('task_action create ok → task_card из свежей сущности, без отдельного текста', () => {
    const execResults: ExecutedVoiceAction[] = [
      { result: { type: 'task_action', draft: taskDraft(), ok: true, error: null, taskId: 't1', undoToken: 'undo-1' }, entity: taskEntity },
    ];
    const parts = buildVoiceAssistantParts(execResults, null);
    expect(parts).toEqual([{ type: MessagePartType.TASK_CARD, order: 0, data: { taskId: 't1', title: 'Задача', status: 'NEW', dueDate: null, assignee: null } }]);
  });

  it('event_action update ok → event_card', () => {
    const execResults: ExecutedVoiceAction[] = [
      {
        result: { type: 'event_action', draft: eventDraft({ action: 'update', targetEventId: 'e1' }), ok: true, error: null, eventId: 'e1', undoToken: 'undo-1' },
        entity: eventEntity,
      },
    ];
    const parts = buildVoiceAssistantParts(execResults, null);
    expect(parts).toEqual([
      {
        type: MessagePartType.EVENT_CARD,
        order: 0,
        data: { eventId: 'e1', title: 'Встреча', startAt: '2026-09-15T10:00:00.000Z', endAt: '2026-09-15T11:00:00.000Z', location: null, participants: [] },
      },
    ]);
  });

  // РЕГРЕССИЯ находки №1 седьмого внешнего аудита (Stage 2, Phase N) —
  // раньше result.warning (частичный сбой addParticipant/removeParticipant,
  // см. VoiceService.applyParticipants) строился бэкендом, но нигде не
  // попадал в EVENT_CARD — карточка строилась только из entity.
  it('event_action create ok, но с warning (частичный сбой участника) → event_card несёт warning', () => {
    const execResults: ExecutedVoiceAction[] = [
      {
        result: {
          type: 'event_action',
          draft: eventDraft({ action: 'create' }),
          ok: true,
          error: null,
          eventId: 'e1',
          undoToken: 'undo-1',
          warning: 'не удалось добавить участника emp2: сотрудник не найден',
        },
        entity: eventEntity,
      },
    ];
    const parts = buildVoiceAssistantParts(execResults, null);
    expect(parts[0].data).toMatchObject({ warning: 'не удалось добавить участника emp2: сотрудник не найден' });
  });

  it('event_action ok без warning → EVENT_CARD не несёт лишнего поля warning в данных', () => {
    const execResults: ExecutedVoiceAction[] = [
      {
        result: { type: 'event_action', draft: eventDraft({ action: 'create' }), ok: true, error: null, eventId: 'e1', undoToken: 'undo-1', warning: null },
        entity: eventEntity,
      },
    ];
    const parts = buildVoiceAssistantParts(execResults, null);
    expect((parts[0].data as { warning?: unknown }).warning).toBeNull();
  });

  it('task_action delete ok → markdown-текст, не карточка (сущности больше нет)', () => {
    const execResults: ExecutedVoiceAction[] = [
      {
        result: { type: 'task_action', draft: taskDraft({ action: 'delete', targetTaskId: 't1', targetTitle: 'Старая задача' }), ok: true, error: null, taskId: 't1', undoToken: null },
        entity: null,
      },
    ];
    const parts = buildVoiceAssistantParts(execResults, null);
    expect(parts).toEqual([{ type: MessagePartType.MARKDOWN, order: 0, data: { content: 'Удалил задачу «Старая задача».' } }]);
  });

  it('event_action delete ok → markdown-текст про встречу', () => {
    const execResults: ExecutedVoiceAction[] = [
      {
        result: { type: 'event_action', draft: eventDraft({ action: 'delete', targetEventId: 'e1', targetTitle: 'Синк' }), ok: true, error: null, eventId: 'e1', undoToken: null },
        entity: null,
      },
    ];
    const parts = buildVoiceAssistantParts(execResults, null);
    expect(parts).toEqual([{ type: MessagePartType.MARKDOWN, order: 0, data: { content: 'Удалил встречу «Синк».' } }]);
  });

  it('ok=false → error-part с безопасным текстом (уже человекочитаемым — NestJS exception.message)', () => {
    const execResults: ExecutedVoiceAction[] = [
      {
        result: { type: 'task_action', draft: taskDraft({ action: 'delete', targetTaskId: 't1' }), ok: false, error: 'Удалить задачу может только постановщик или руководитель', taskId: null, undoToken: null },
        entity: null,
      },
    ];
    const parts = buildVoiceAssistantParts(execResults, null);
    expect(parts).toEqual([{ type: MessagePartType.ERROR, order: 0, data: { message: 'Удалить задачу может только постановщик или руководитель' } }]);
  });

  it('несколько независимых команд в одном транскрипте → части в том же порядке, order по возрастанию', () => {
    const execResults: ExecutedVoiceAction[] = [
      {
        result: { type: 'event_action', draft: eventDraft({ action: 'delete', targetEventId: 'e1', targetTitle: 'Старая встреча' }), ok: true, error: null, eventId: 'e1', undoToken: null },
        entity: null,
      },
      { result: { type: 'event_action', draft: eventDraft(), ok: true, error: null, eventId: 'e2', undoToken: 'undo-2' }, entity: { ...eventEntity, id: 'e2' } },
    ];
    const parts = buildVoiceAssistantParts(execResults, null);
    expect(parts.map((p) => p.type)).toEqual([MessagePartType.MARKDOWN, MessagePartType.EVENT_CARD]);
    expect(parts.map((p) => p.order)).toEqual([0, 1]);
    expect(parts[1].data).toMatchObject({ eventId: 'e2' });
  });

  it('clarificationReason — отдельная markdown-часть последней, после всех execResults', () => {
    const execResults: ExecutedVoiceAction[] = [{ result: { type: 'chat', reply: 'Ок.' }, entity: null }];
    const parts = buildVoiceAssistantParts(execResults, 'Не до конца понял срок — уточните, пожалуйста.');
    expect(parts.map((p) => p.type)).toEqual([MessagePartType.MARKDOWN, MessagePartType.MARKDOWN]);
    expect(parts[1].data).toEqual({ content: 'Не до конца понял срок — уточните, пожалуйста.' });
  });

  it('пустой clarificationReason (null) не добавляет лишнюю часть', () => {
    const execResults: ExecutedVoiceAction[] = [{ result: { type: 'chat', reply: 'Ок.' }, entity: null }];
    const parts = buildVoiceAssistantParts(execResults, null);
    expect(parts).toHaveLength(1);
  });
});

// Живой прогон Phase H, 20.09.2026: draft-extraction.service.ts кладёт в
// clarificationReason буквальный текст "null" (не JSON null — Anthropic не
// поддерживает nullable-строки в строгой схеме, см. OPTIONAL_STRING там же),
// когда clarificationNeeded = false. Без гейта на clarificationNeeded каждый
// обычный голосовой ответ показывал бы лишний пузырь с текстом "null" —
// поймано живым прогоном с реальным Whisper+Claude, не юнит-тестом (их не
// было до этого случая).
describe('resolveClarificationReason (регресс — живой прогон Phase H, 20.09.2026)', () => {
  it('clarificationNeeded=false — null независимо от текста в clarificationReason (в т.ч. буквального "null" от модели)', () => {
    expect(resolveClarificationReason(false, 'null')).toBeNull();
    expect(resolveClarificationReason(false, 'Настоящая причина уточнения')).toBeNull();
    expect(resolveClarificationReason(false, null)).toBeNull();
  });

  it('clarificationNeeded=true с непустой причиной — возвращает её', () => {
    expect(resolveClarificationReason(true, 'Такая задача уже существует — возможно, дубль.')).toBe(
      'Такая задача уже существует — возможно, дубль.',
    );
  });

  it('clarificationNeeded=true, но clarificationReason=null — null, не падает', () => {
    expect(resolveClarificationReason(true, null)).toBeNull();
  });
});
