/* eslint-disable @typescript-eslint/require-await -- фейковый клиент модели */
import { AnswerStructuringService } from './answer-structuring.service';

function serviceReturning(input: { has_answer: boolean; text: string } | Error) {
  const service = new AnswerStructuringService({ getOrThrow: () => 'key' } as any);
  const create = jest.fn(async () => {
    if (input instanceof Error) throw input;
    return { content: [{ type: 'tool_use', input }] };
  });
  (service as any).client = { messages: { create } };
  return { service, create };
}

describe('AnswerStructuringService', () => {
  it('короткий ответ — без модели, с заглавной и точкой', async () => {
    const { service, create } = serviceReturning({ has_answer: false, text: '' });
    await expect(service.structure('да')).resolves.toEqual({ kind: 'answer', text: 'Да.' });
    expect(create).not.toHaveBeenCalled();
  });

  it('модель говорит «ответа нет» — no_answer, её текст не используется', async () => {
    const { service } = serviceReturning({ has_answer: false, text: 'В тексте нет осмысленного ответа' });
    await expect(service.structure('ну это самое как его ну')).resolves.toEqual({ kind: 'no_answer' });
  });

  it('модель дописала заметно больше сказанного — возвращается сырой текст', async () => {
    const raw = 'согласовано делайте закупку сами';
    const { service } = serviceReturning({ has_answer: true, text: 'Согласовано. '.repeat(20) });
    await expect(service.structure(raw)).resolves.toEqual({ kind: 'answer', text: raw });
  });

  it('сбой модели — сырой текст', async () => {
    const raw = 'согласовано делайте закупку до пятницы';
    const { service } = serviceReturning(new Error('down'));
    await expect(service.structure(raw)).resolves.toEqual({ kind: 'answer', text: raw });
  });

  it('обычная редактура', async () => {
    const { service } = serviceReturning({ has_answer: true, text: 'Согласовано. Закупку — до пятницы.' });
    await expect(service.structure('ну короче согласовано закупку до пятницы')).resolves.toEqual({
      kind: 'answer',
      text: 'Согласовано. Закупку — до пятницы.',
    });
  });
});
