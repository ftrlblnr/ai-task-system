import { LiveTranscriptBuffer, MAX_CONTEXT_CHARS, MAX_CONTEXT_TURNS } from './live-transcript-buffer';

// Сценарий из анализа: «Мы обсуждали предложение IDAT» → Live отвечает →
// «Создай из этого задачу Жандосу». Assistant Core должен получить и
// предыдущий ход пользователя, и предыдущую реплику Live, и текущую команду.
function scenarioIdat() {
  const b = new LiveTranscriptBuffer();
  b.addFragment('user', 'Мы обсуждали предложение IDAT. ', 0, 2000);
  b.addFragment('assistant', 'Да, речь шла о стоимости автоматизации precast. ', 2100, 4000);
  b.addFragment('user', 'Создай из этого задачу Жандосу.', 4500, 6500);
  return b;
}

describe('LiveTranscriptBuffer — команда и контекст', () => {
  it('«создай из этого…»: контекст содержит прошлый ход пользователя И прошлую реплику Live, команда — только текущая', () => {
    const b = scenarioIdat();
    // первая user-реплика уже была делегирована ранее
    expect(b.takeTurn(2000).command).toBe('Мы обсуждали предложение IDAT.');

    const { command, context } = b.takeTurn(6600);

    expect(command).toBe('Создай из этого задачу Жандосу.');
    expect(context).toContain('User: Мы обсуждали предложение IDAT.');
    expect(context).toContain('Assistant: Да, речь шла о стоимости автоматизации precast.');
    expect(context).not.toContain('Создай из этого');
  });

  it('«поставь ему задачу»: предыдущий человек виден в контексте', () => {
    const b = new LiveTranscriptBuffer();
    b.addFragment('user', 'Что Жандос говорил про IDAT? ', 0, 1500);
    b.addFragment('assistant', 'Жандос предложил запросить коммерческое предложение. ', 1600, 3500);
    b.takeTurn(1500);
    b.addFragment('user', 'Поставь ему задачу до пятницы.', 4000, 5500);

    const { command, context } = b.takeTurn(5600);

    expect(command).toBe('Поставь ему задачу до пятницы.');
    expect(context).toContain('Жандос');
  });

  it('фрагмент после границы (startMs > offset_ms) не входит в команду и остаётся для следующей делегации', () => {
    const b = new LiveTranscriptBuffer();
    b.addFragment('user', 'Создай задачу Амиру. ', 0, 1500);
    b.addFragment('user', 'А ещё напомни про встречу.', 3000, 4500);

    expect(b.takeTurn(1600).command).toBe('Создай задачу Амиру.');
    expect(b.hasUnconsumedUserText()).toBe(true);
    expect(b.takeTurn(4600).command).toBe('А ещё напомни про встречу.');
  });

  it('потреблённая команда повторно не берётся', () => {
    const b = scenarioIdat();
    b.takeTurn(6600);

    expect(b.takeTurn(6600).command).toBe('');
    expect(b.hasUnconsumedUserText()).toBe(false);
  });

  it('фрагменты без тайминга относятся к текущей команде', () => {
    const b = new LiveTranscriptBuffer();
    b.addFragment('user', 'Покажи ');
    b.addFragment('user', 'задачи');

    expect(b.takeTurn(100).command).toBe('Покажи задачи');
  });

  it('ещё не взятая user-речь не попадает в контекст (это следующая реплика)', () => {
    const b = new LiveTranscriptBuffer();
    b.addFragment('user', 'Первая. ', 0, 1000);
    b.takeTurn(1000);
    b.addFragment('user', 'Вторая ещё говорится', 2000, 3000);

    expect(b.takeTurn(1500).context).not.toContain('Вторая');
  });

  it('userCoverageMs отражает самую дальнюю точку user-речи', () => {
    const b = new LiveTranscriptBuffer();
    expect(b.userCoverageMs).toBe(-1);
    b.addFragment('user', 'а', 0, 1000);
    b.addFragment('assistant', 'б', 1000, 9000);
    b.addFragment('user', 'в', 1000, 2500);

    expect(b.userCoverageMs).toBe(2500);
  });
});

describe('LiveTranscriptBuffer — ограничения размера', () => {
  it('контекст — только последние ходы и укладывается в лимит символов', () => {
    const b = new LiveTranscriptBuffer();
    for (let i = 0; i < 40; i++) {
      b.addFragment(i % 2 === 0 ? 'user' : 'assistant', `Реплика номер ${i} ${'слово '.repeat(20)}`, i * 1000, i * 1000 + 900);
      if (i % 2 === 0) b.takeTurn(i * 1000 + 950);
    }

    const { context } = b.takeTurn(10_000_000);

    expect(context.length).toBeLessThanOrEqual(MAX_CONTEXT_CHARS);
    expect(context.split('\n').length).toBeLessThanOrEqual(MAX_CONTEXT_TURNS);
    expect(context).toContain('номер 39'); // самое свежее сохранено
    expect(context).not.toContain('номер 0 ');
  });

  it('старые потреблённые фрагменты вне окна ~3 минут вытесняются', () => {
    const b = new LiveTranscriptBuffer();
    b.addFragment('user', 'Очень старое.', 0, 1000);
    b.takeTurn(1000);
    b.addFragment('assistant', 'Свежее.', 5 * 60 * 1000, 5 * 60 * 1000 + 500);

    const { context } = b.takeTurn(10_000_000);
    expect(context).not.toContain('Очень старое');
    expect(context).toContain('Свежее');
  });
});
