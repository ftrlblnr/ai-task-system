import { AssistantChatService } from './assistant-chat.service';
import { LegalReviewNotifier } from './legal-review-notifier.service';

const REVIEW = { contract: 'Договор', gcRole: '', applicableActs: '', summary: 'Итог разбора', findings: [], generalIssues: [], notChecked: [], model: 'm' };
const run = (over: Record<string, unknown> = {}) => ({
  id: 'r1',
  employeeId: 'u1',
  conversationId: 'c1',
  status: 'SUCCEEDED',
  fileName: 'Договор.docx',
  result: REVIEW,
  reportFileId: 'rep1',
  error: null,
  ...over,
});

function make(runs: unknown[], delivered = true) {
  const tx = { legalReviewRun: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) } };
  const prisma = {
    legalReviewRun: { findMany: jest.fn().mockResolvedValue(runs), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    fileArtifact: { findUnique: jest.fn().mockResolvedValue({ id: 'rep1', name: 'Разбор — Договор.docx', mimeType: 'x', size: 10 }) },
  };
  const chat = {
    appendBackgroundMessage: jest.fn().mockImplementation(async (_c: string, _p: unknown, _f: unknown, claim: (t: unknown) => Promise<boolean>) => {
      await claim(tx);
      return delivered;
    }),
  };
  const realtime = { publish: jest.fn() };
  return { notifier: new LegalReviewNotifier(prisma as never, chat as never, realtime as never), prisma, chat, tx, realtime };
}

describe('LegalReviewNotifier', () => {
  it('готовый разбор — сводка и файл отчёта в беседу, отметка notifiedAt в той же транзакции', async () => {
    const { notifier, prisma, chat, tx, realtime } = make([run()]);
    await notifier.deliverFinished();
    expect(prisma.legalReviewRun.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ notifiedAt: null, conversationId: { not: null } }) }));
    const [conversationId, parts, fileIds] = chat.appendBackgroundMessage.mock.calls[0];
    expect(conversationId).toBe('c1');
    expect(parts[0].data.content).toContain('**Разбор договора «Договор.docx» готов.**');
    expect(parts[1]).toMatchObject({ type: 'FILE', data: { fileId: 'rep1', name: 'Разбор — Договор.docx' } });
    expect(fileIds).toEqual(['rep1']);
    expect(tx.legalReviewRun.updateMany).toHaveBeenCalledWith({ where: { id: 'r1', notifiedAt: null }, data: { notifiedAt: expect.any(Date) } });
    expect(prisma.legalReviewRun.updateMany).not.toHaveBeenCalled();
    expect(realtime.publish).toHaveBeenCalledWith('assistant', 'u1');
  });

  it('неудачный разбор — сообщение с причиной, без файла', async () => {
    const { notifier, chat } = make([run({ status: 'FAILED', result: null, reportFileId: null, error: 'В файле нет текста' })]);
    await notifier.deliverFinished();
    const [, parts, fileIds] = chat.appendBackgroundMessage.mock.calls[0];
    expect(parts).toHaveLength(1);
    expect(parts[0].data.content).toBe('**Разбор договора «Договор.docx» не выполнен.** В файле нет текста');
    expect(fileIds).toEqual([]);
  });

  it('беседу удалили — отмечаем доставленным, чтобы не перебирать вечно', async () => {
    const { notifier, prisma } = make([run()], false);
    await notifier.deliverFinished();
    expect(prisma.legalReviewRun.updateMany).toHaveBeenCalledWith({ where: { id: 'r1', notifiedAt: null }, data: { notifiedAt: expect.any(Date) } });
  });
});

describe('AssistantChatService.appendBackgroundMessage', () => {
  function make(claimed: boolean, conversation: unknown) {
    const tx = {
      conversation: { findUnique: jest.fn().mockResolvedValue(conversation), update: jest.fn() },
      message: { create: jest.fn().mockResolvedValue({ id: 'm1' }) },
      fileArtifact: { updateMany: jest.fn() },
    };
    const prisma = { $transaction: (fn: (t: typeof tx) => Promise<boolean>) => fn(tx) };
    const service = Object.create(AssistantChatService.prototype) as AssistantChatService;
    (service as unknown as { prisma: unknown }).prisma = prisma;
    return { service, tx, claim: jest.fn().mockResolvedValue(claimed) };
  }
  const parts = [{ type: 'MARKDOWN', order: 0, data: { content: 'x' } }] as never;

  it('claim прошёл — сообщение, привязка файлов, беседа наверх', async () => {
    const { service, tx, claim } = make(true, { id: 'c1' });
    expect(await service.appendBackgroundMessage('c1', parts, ['f1'], claim)).toBe(true);
    expect(tx.message.create).toHaveBeenCalledWith({ data: expect.objectContaining({ conversationId: 'c1', role: 'ASSISTANT', status: 'COMPLETED' }) });
    expect(tx.fileArtifact.updateMany).toHaveBeenCalledWith({ where: { id: { in: ['f1'] } }, data: { conversationId: 'c1', messageId: 'm1' } });
    expect(tx.conversation.update).toHaveBeenCalled();
  });

  it('уже доставлено или беседы нет — ничего не пишет', async () => {
    for (const [claimed, conversation] of [
      [false, { id: 'c1' }],
      [true, null],
    ] as const) {
      const { service, tx, claim } = make(claimed, conversation);
      expect(await service.appendBackgroundMessage('c1', parts, [], claim)).toBe(false);
      expect(tx.message.create).not.toHaveBeenCalled();
    }
  });
});
