/* eslint-disable @typescript-eslint/require-await -- фейковый клиент модели */
import { AnswerStructuringService } from './answer-structuring.service';

function serviceReturning(input: { text: string } | Error) {
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
    const { service, create } = serviceReturning({ text: '' });
    await expect(service.structure('да')).resolves.toBe('Да.');
    expect(create).not.toHaveBeenCalled();
  });

  it('модель вернула пустой текст — сырой текст, запись не теряется', async () => {
    const raw = 'проверка это тестовый ответ голосом';
    const { service } = serviceReturning({ text: '' });
    await expect(service.structure(raw)).resolves.toBe(raw);
  });

  it('модель дописала заметно больше сказанного — возвращается сырой текст', async () => {
    const raw = 'согласовано делайте закупку сами';
    const { service } = serviceReturning({ text: 'Согласовано. '.repeat(20) });
    await expect(service.structure(raw)).resolves.toBe(raw);
  });

  it('сбой модели — сырой текст', async () => {
    const raw = 'согласовано делайте закупку до пятницы';
    const { service } = serviceReturning(new Error('down'));
    await expect(service.structure(raw)).resolves.toBe(raw);
  });

  it('обычная редактура', async () => {
    const { service } = serviceReturning({ text: 'Согласовано. Закупку — до пятницы.' });
    await expect(service.structure('ну короче согласовано закупку до пятницы')).resolves.toBe('Согласовано. Закупку — до пятницы.');
  });
});
