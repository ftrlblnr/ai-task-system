import { buildFeedbackUserContent, buildToneUserContent, countToneEmails, parseRevision, RevisionParseError, stripQuoted } from './skill-revision-prompt';

describe('предложения правок навыка', () => {
  it('цитата исходного письма отрезается', () => {
    expect(stripQuoted('Добрый день!\nСогласен.\n\nС уважением\n\n25.10.2026, Иван пишет:\n> старый текст')).toBe('Добрый день!\nСогласен.\n\nС уважением');
    expect(stripQuoted('Ок\n-----Original Message-----\nFrom: x')).toBe('Ок');
    expect(stripQuoted('Ок\nОт: Иван <i@x.kz>\nТема: …')).toBe('Ок');
  });

  it('письма короче 20 символов не считаются', () => {
    const emails = [{ subject: 'a', body: 'Ок' }, { subject: 'b', body: 'Прошу подготовить смету к пятнице.' }];
    expect(countToneEmails(emails)).toBe(1);
    expect(buildToneUserContent(emails)).toContain('Отправленные письма руководителя (1)');
  });

  it('отзывы — в промпте с оценкой, комментарием и ответом', () => {
    const text = buildFeedbackUserContent({ slug: 'день', title: 'Мой день', instructions: 'Шаги' }, [
      { value: 'DOWN', text: 'слишком длинно', input: '', answer: 'Длинный ответ' },
    ]);
    expect(text).toContain('👎');
    expect(text).toContain('Комментарий: слишком длинно');
    expect(text).toContain('Запрос: (без уточнений)');
  });

  it('разбор ответа модели', () => {
    expect(parseRevision(JSON.stringify({ instructions: '  Новая инструкция навыка, шаги и формат.  ', reason: 'по отзыву' }))).toEqual({
      instructions: 'Новая инструкция навыка, шаги и формат.',
      reason: 'по отзыву',
    });
    expect(() => parseRevision('не json')).toThrow(RevisionParseError);
    expect(() => parseRevision(JSON.stringify({ instructions: 'коротко' }))).toThrow(RevisionParseError);
  });
});
