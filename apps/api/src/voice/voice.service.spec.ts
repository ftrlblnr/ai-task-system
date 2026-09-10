import { Role } from '@prisma/client';
import { VoiceService } from './voice.service';
import type { VoiceEventActionDraft, VoiceTaskActionDraft } from './dto/voice-draft-response.dto';

// Ни validateTarget, ни validateEventCreateCompleteness, ни
// validateReferences, ни enforceEventRbac не трогают внедрённые зависимости
// (whisper/extraction/prisma/audit/tasks/events) — заглушены, тестируем
// саму логику (аудит 10.09.2026, п. 5.1).
function makeService(): any {
  return new VoiceService({} as any, {} as any, {} as any, {} as any, {} as any, {} as any) as any;
}

function taskDraft(overrides: Partial<VoiceTaskActionDraft> = {}): VoiceTaskActionDraft {
  return {
    type: 'task_action',
    action: 'update',
    targetTaskId: 't1',
    targetTitle: 'Задача',
    title: '',
    description: '',
    assigneeId: null,
    assigneeName: null,
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

describe('VoiceService.validateTarget (закрытый список id вместо enum в схеме, см. draft-extraction.service.ts)', () => {
  const service = makeService();

  it('task_action update/delete с неизвестным targetTaskId превращается в chat-уточнение', () => {
    const result = service.validateTarget(taskDraft({ action: 'delete', targetTaskId: 'unknown' }), new Set(['t1']), new Set());
    expect(result.type).toBe('chat');
  });

  it('task_action update/delete с известным targetTaskId проходит без изменений', () => {
    const draft = taskDraft({ action: 'update', targetTaskId: 't1' });
    const result = service.validateTarget(draft, new Set(['t1']), new Set());
    expect(result).toBe(draft);
  });

  it('task_action create не проверяется (targetTaskId у него пустой по определению)', () => {
    const draft = taskDraft({ action: 'create', targetTaskId: '' });
    const result = service.validateTarget(draft, new Set(), new Set());
    expect(result).toBe(draft);
  });

  it('event_action update/delete с неизвестным targetEventId превращается в chat-уточнение', () => {
    const result = service.validateTarget(
      eventDraft({ action: 'update', targetEventId: 'unknown' }),
      new Set(),
      new Set(['e1']),
    );
    expect(result.type).toBe('chat');
  });
});

describe('VoiceService.validateEventCreateCompleteness (владелец 10.09.2026 — startAt обязателен на create)', () => {
  const service = makeService();

  it('event_action create без startAt превращается в chat-уточнение, а не создаёт битое событие', () => {
    const result = service.validateEventCreateCompleteness(eventDraft({ startAt: null }));
    expect(result.type).toBe('chat');
  });

  it('event_action create со startAt проходит без изменений', () => {
    const draft = eventDraft({ startAt: '2026-09-15T15:00:00+05:00' });
    const result = service.validateEventCreateCompleteness(draft);
    expect(result).toBe(draft);
  });

  it('event_action update без startAt НЕ трогается (startAt=null для update значит "не упомянуто", не ошибка)', () => {
    const draft = eventDraft({ action: 'update', startAt: null });
    const result = service.validateEventCreateCompleteness(draft);
    expect(result).toBe(draft);
  });
});

describe('VoiceService.validateReferences (fail-safe в null/отфильтрованный список, не в ошибку)', () => {
  const service = makeService();
  const knownEmployees = new Set(['emp1', 'emp2']);

  it('невалидный assigneeId у task_action превращается в null', () => {
    const result = service.validateReferences(taskDraft({ assigneeId: 'ghost' }), knownEmployees);
    expect(result.assigneeId).toBeNull();
  });

  it('валидный assigneeId остаётся как есть', () => {
    const result = service.validateReferences(taskDraft({ assigneeId: 'emp1' }), knownEmployees);
    expect(result.assigneeId).toBe('emp1');
  });

  it('невалидные id участников события отфильтровываются, валидные остаются', () => {
    const result = service.validateReferences(
      eventDraft({ addParticipantIds: ['emp1', 'ghost'], removeParticipantIds: ['ghost'] }),
      knownEmployees,
    );
    expect(result.addParticipantIds).toEqual(['emp1']);
    expect(result.removeParticipantIds).toEqual([]);
  });
});

describe('VoiceService.enforceEventRbac (граница безопасности — не полагается на промпт, см. комментарий в самом коде)', () => {
  const service = makeService();

  it('руководителю событие не трогает — возвращает массив из одного элемента без изменений', () => {
    const draft = eventDraft();
    const result = service.enforceEventRbac(draft, Role.OWNER);
    expect(result).toEqual([draft]);
  });

  it('не-руководителю event_action create разворачивается в [задача, chat-объяснение]', () => {
    const result = service.enforceEventRbac(eventDraft({ title: 'Встреча по проекту' }), Role.EMPLOYEE);
    expect(result).toHaveLength(2);
    expect(result[0].type).toBe('task_action');
    expect(result[0].action).toBe('create');
    expect(result[0].title).toBe('Встреча по проекту');
    expect(result[1].type).toBe('chat');
  });

  it('не-руководителю event_action update/delete превращается в отказ (chat), календарь ему недоступен', () => {
    const result = service.enforceEventRbac(eventDraft({ action: 'update' }), Role.EMPLOYEE);
    expect(result).toEqual([{ type: 'chat', reply: expect.stringContaining('руководителю') }]);
  });

  it('task_action не трогается независимо от роли', () => {
    const draft = taskDraft();
    expect(service.enforceEventRbac(draft, Role.EMPLOYEE)).toEqual([draft]);
  });
});
