import { stripLeakedContextMarkers } from './assistant-reply.service';

// Живая проверка Phase G (16.09.2026) поймала, что модель иногда дословно
// копирует служебный формат serializeMessageForModelContext из истории
// разговора в собственный ответ — инструкция в SYSTEM_PROMPT одна не
// всегда надёжна (сильная имитация формата у Haiku), нужна
// детерминированная зачистка после генерации.
describe('stripLeakedContextMarkers (Stage 2, Phase G — защита от утечки служебного формата истории)', () => {
  it('убирает целиком просочившийся блок [file]', () => {
    const text = stripLeakedContextMarkers(
      'Готово, файл сформирован.\n[file]\nid=abc123\nname=Задачи.xlsx\nmimeType=application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(text).toBe('Готово, файл сформирован.');
  });

  it('убирает просочившийся блок [shown_task]', () => {
    const text = stripLeakedContextMarkers('Вот что я нашёл.\n[shown_task]\nid=t1\ntitle=Задача А\nstatus=NEW');
    expect(text).toBe('Вот что я нашёл.');
  });

  it('убирает просочившийся блок [shown_event]', () => {
    const text = stripLeakedContextMarkers('Встреча уже была показана.\n[shown_event]\nid=e1\ntitle=Синк\nstartAt=2026-09-16T10:00:00.000Z');
    expect(text).toBe('Встреча уже была показана.');
  });

  it('не трогает обычный текст без служебных пометок', () => {
    const text = stripLeakedContextMarkers('Обычный ответ ассистента, без карточек и файлов.');
    expect(text).toBe('Обычный ответ ассистента, без карточек и файлов.');
  });

  it('не трогает случайное упоминание "[file]" без следующих строк key=value', () => {
    const text = stripLeakedContextMarkers('В параметре [file] нужно указать путь.');
    expect(text).toBe('В параметре [file] нужно указать путь.');
  });
});
