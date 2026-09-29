import {
  MAX_ANALYSIS_ATTACHMENT_CHARS,
  MAX_ANALYSIS_BODY_CHARS,
  buildAnalysisTool,
  buildAnalysisUserContent,
  computeAnalysisInputHash,
  type EmailAnalysisInput,
} from './mail-analysis';

function input(overrides: Partial<EmailAnalysisInput> = {}): EmailAnalysisInput {
  return {
    subject: 'Тема письма',
    fromAddress: 'sender@example.com',
    fromName: 'Иван Иванов',
    sentAt: new Date('2026-09-27T10:00:00.000Z'),
    receivedAt: new Date('2026-09-27T10:00:05.000Z'),
    to: ['boss@mail.ru'],
    cc: [],
    textBody: 'Тело письма.',
    attachments: [],
    ...overrides,
  };
}

describe('buildAnalysisUserContent', () => {
  it('включает отправителя, получателей, дату и тему', () => {
    const content = buildAnalysisUserContent(input());
    expect(content).toContain('Иван Иванов <sender@example.com>');
    expect(content).toContain('boss@mail.ru');
    expect(content).toContain('Тема письма');
    expect(content).toContain('Тело письма.');
  });

  it('не добавляет строку "Копия", если CC пуст', () => {
    expect(buildAnalysisUserContent(input({ cc: [] }))).not.toContain('Копия:');
  });

  it('добавляет строку "Копия" со списком адресов', () => {
    const content = buildAnalysisUserContent(input({ cc: ['a@x.com', 'b@x.com'] }));
    expect(content).toContain('Копия: a@x.com, b@x.com');
  });

  it('обрезает тело письма по MAX_ANALYSIS_BODY_CHARS', () => {
    const longBody = 'x'.repeat(MAX_ANALYSIS_BODY_CHARS + 500);
    const content = buildAnalysisUserContent(input({ textBody: longBody }));
    expect(content).toContain('…');
    expect(content.length).toBeLessThan(longBody.length + 500);
  });

  it('пустое тело письма не ломает рендер', () => {
    expect(buildAnalysisUserContent(input({ textBody: null }))).toContain('(пустое тело письма)');
  });

  it('включает извлечённый текст вложения с именем файла, обрезая по MAX_ANALYSIS_ATTACHMENT_CHARS', () => {
    const longText = 'y'.repeat(MAX_ANALYSIS_ATTACHMENT_CHARS + 100);
    const content = buildAnalysisUserContent(
      input({ attachments: [{ fileName: 'contract.pdf', extractedText: longText }] }),
    );
    expect(content).toContain('Вложение «contract.pdf»:');
    expect(content).not.toContain(longText);
  });

  it('пропускает вложения без извлечённого текста', () => {
    const content = buildAnalysisUserContent(
      input({ attachments: [{ fileName: 'photo.png', extractedText: null }] }),
    );
    expect(content).not.toContain('photo.png');
  });
});

describe('computeAnalysisInputHash', () => {
  it('детерминирован для одинакового входа', () => {
    expect(computeAnalysisInputHash(input())).toBe(computeAnalysisInputHash(input()));
  });

  it('меняется при изменении тела письма', () => {
    expect(computeAnalysisInputHash(input({ textBody: 'A' }))).not.toBe(computeAnalysisInputHash(input({ textBody: 'B' })));
  });
});

describe('buildAnalysisTool', () => {
  it('схема требует все поля и запрещает лишние', () => {
    const tool = buildAnalysisTool();
    expect(tool.input_schema.required).toEqual([
      'summary',
      'importance',
      'category',
      'needsReply',
      'needsAction',
      'actionSummary',
      'deadline',
    ]);
    expect(tool.input_schema.additionalProperties).toBe(false);
  });

  it('перечисления importance/category совпадают с enum схемы Prisma', () => {
    const tool = buildAnalysisTool();
    const props = tool.input_schema.properties as Record<string, { enum?: string[] }>;
    expect(props.importance.enum).toEqual(['CRITICAL', 'IMPORTANT', 'NORMAL', 'LOW']);
    expect(props.category.enum).toEqual([
      'ACTION_REQUIRED',
      'DECISION_REQUIRED',
      'INFORMATION',
      'DOCUMENT',
      'COMMERCIAL',
      'LEGAL',
      'FINANCE',
      'PROJECT',
      'MEETING',
      'NEWSLETTER',
      'OTHER',
    ]);
  });
});
