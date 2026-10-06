import { buildMailActionTool, buildMailActionUserContent, convertMailActionProposals, STAGE1_ANALYSIS_ACTION_TYPES } from './mail-action-analysis';
import type { MessageForActionAnalysis } from '../mail-store';

function message(overrides: Partial<MessageForActionAnalysis> = {}): MessageForActionAnalysis {
  return {
    id: 'm1',
    uid: 10,
    subject: 'Тема',
    fromAddress: 'sender@example.com',
    fromName: 'Иван Иванов',
    receivedAt: new Date('2026-09-27T10:00:00.000Z'),
    isRead: false,
    hasAttachments: false,
    textBody: 'Тело письма.',
    folder: { path: 'INBOX', uidValidity: '123' },
    analysis: null,
    ...overrides,
  };
}

describe('buildMailActionUserContent', () => {
  it('включает запрос, папки ящика и письма по номерам', () => {
    const content = buildMailActionUserContent('архивируй рассылки', [message()], [{ path: 'INBOX' }, { path: 'INBOX/News' }]);
    expect(content).toContain('Запрос владельца: архивируй рассылки');
    expect(content).toContain('Папки ящика: INBOX, INBOX/News');
    expect(content).toContain('1. От: Иван Иванов <sender@example.com>');
    expect(content).toContain('Тема');
  });

  it('пустой список папок показывает явную пометку', () => {
    expect(buildMailActionUserContent('x', [], [])).toContain('(нет синкнутых папок)');
  });

  it('добавляет строку анализа только если есть importance и category', () => {
    const withAnalysis = buildMailActionUserContent('x', [message({ analysis: { importance: 'IMPORTANT', category: 'PROJECT' } })], []);
    expect(withAnalysis).toContain('Анализ: IMPORTANT/PROJECT');
    const withoutAnalysis = buildMailActionUserContent('x', [message({ analysis: null })], []);
    expect(withoutAnalysis).not.toContain('Анализ:');
  });

  it('обрезает тело письма по лимиту', () => {
    const long = 'а'.repeat(1000);
    const content = buildMailActionUserContent('x', [message({ textBody: long })], []);
    expect(content).toContain('…');
    expect(content.length).toBeLessThan(long.length + 500);
  });
});

describe('convertMailActionProposals (ТЗ разд. 5/9)', () => {
  const inbox = message({ id: 'm1', uid: 10, folder: { path: 'INBOX', uidValidity: '123' } });

  it('создаёт пункт ARCHIVE без параметров', () => {
    const candidates = convertMailActionProposals(
      [{ messageIndex: 1, type: 'ARCHIVE', folderPath: null, reason: 'рассылка', relevance: 'RECOMMENDED' }],
      [inbox],
      new Set(),
    );
    expect(candidates).toEqual([
      {
        localId: 'a0',
        type: 'ARCHIVE',
        stableObjectIds: ['m1'],
        sourceLocators: { folderPath: 'INBOX', uidValidity: '123', uid: 10 },
        reason: 'рассылка',
        relevance: 'RECOMMENDED',
        parameters: {},
      },
    ]);
  });

  it('MOVE в существующую папку — создаёт пункт с folderPath в параметрах', () => {
    const candidates = convertMailActionProposals(
      [{ messageIndex: 1, type: 'MOVE', folderPath: 'INBOX/News', reason: 'новости', relevance: 'RECOMMENDED' }],
      [inbox],
      new Set(['INBOX/News']),
    );
    expect(candidates[0].parameters).toEqual({ folderPath: 'INBOX/News' });
  });

  it('MOVE в несуществующую папку — пункт не создаётся', () => {
    const candidates = convertMailActionProposals(
      [{ messageIndex: 1, type: 'MOVE', folderPath: 'INBOX/Выдуманная', reason: 'x', relevance: 'RECOMMENDED' }],
      [inbox],
      new Set(['INBOX/News']),
    );
    expect(candidates).toHaveLength(0);
  });

  it('MOVE без folderPath — пункт не создаётся', () => {
    const candidates = convertMailActionProposals(
      [{ messageIndex: 1, type: 'MOVE', folderPath: null, reason: 'x', relevance: 'RECOMMENDED' }],
      [inbox],
      new Set(['INBOX/News']),
    );
    expect(candidates).toHaveLength(0);
  });

  it('некорректный messageIndex от модели — пункт тихо пропускается, не роняет весь анализ', () => {
    const candidates = convertMailActionProposals(
      [{ messageIndex: 99, type: 'ARCHIVE', folderPath: null, reason: 'x', relevance: 'RECOMMENDED' }],
      [inbox],
      new Set(),
    );
    expect(candidates).toHaveLength(0);
  });

  it('письмо из папки без uidValidity — пропускается защитно', () => {
    const noValidity = message({ id: 'm2', folder: { path: 'INBOX', uidValidity: null } });
    const candidates = convertMailActionProposals(
      [{ messageIndex: 1, type: 'ARCHIVE', folderPath: null, reason: 'x', relevance: 'RECOMMENDED' }],
      [noValidity],
      new Set(),
    );
    expect(candidates).toHaveLength(0);
  });
});

describe('buildMailActionTool', () => {
  it('перечисляет ровно 7 типов действий Этапа 1 (без CREATE_FOLDER)', () => {
    const tool = buildMailActionTool();
    const typeEnum = (tool.input_schema.properties as Record<string, { enum?: string[] }>).actions as unknown as {
      items: { properties: { type: { enum: string[] } } };
    };
    expect(typeEnum.items.properties.type.enum).toEqual([...STAGE1_ANALYSIS_ACTION_TYPES]);
    expect(typeEnum.items.properties.type.enum).not.toContain('CREATE_FOLDER');
  });
});
