/* eslint-disable @typescript-eslint/require-await -- фейковый клиент модели */
import { MeetingTaskExtractionService } from './meeting-task-extraction.service';

function serviceReturning(response: object) {
  const service = new MeetingTaskExtractionService({ getOrThrow: () => 'key' } as any);
  (service as any).client = { messages: { create: jest.fn(async () => response) } };
  return service;
}

describe('MeetingTaskExtractionService', () => {
  it('ответ оборван по max_tokens — понятная ошибка, а не падение на undefined', async () => {
    const service = serviceReturning({ stop_reason: 'max_tokens', content: [{ type: 'tool_use', input: {} }] });
    await expect(service.extract('саммари', 'Встреча', '2026-10-01', [])).rejects.toThrow('Встреча слишком длинная');
  });

  it('нет списка задач в ответе — ошибка', async () => {
    const service = serviceReturning({ stop_reason: 'tool_use', content: [{ type: 'tool_use', input: {} }] });
    await expect(service.extract('саммари', 'Встреча', '2026-10-01', [])).rejects.toThrow('не вернул структурированный список задач');
  });

  it('обычный ответ — список задач', async () => {
    const tasks = [{ title: 'Подготовить отчёт', description: '', assigneeId: null, dueDate: null }];
    const service = serviceReturning({ stop_reason: 'tool_use', content: [{ type: 'tool_use', input: { tasks } }] });
    await expect(service.extract('саммари', 'Встреча', '2026-10-01', [])).resolves.toEqual(tasks);
  });
});
