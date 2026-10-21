import { Document, Packer, Paragraph } from 'docx';
import { DOCX_MIME } from '../files/file-signature';
import { LegalAgentError } from './legal-agent.service';
import { LegalReviewExecutionService, MAX_REVIEW_ATTEMPTS } from './legal-review-execution.service';

const CLAUSE = 'Гарантийный срок на выполненные работы составляет восемь лет с даты подписания акта выполненных работ.';
const RUN = { id: 'r1', employeeId: 'u1', fileId: 'f1', fileName: 'Договор.docx', focus: null, attempts: 1 } as never;

async function contractDocx(): Promise<Buffer> {
  return Packer.toBuffer(new Document({ sections: [{ children: [CLAUSE, CLAUSE, CLAUSE].map((t) => new Paragraph(t)) }] }));
}

function make(review: jest.Mock, mimeType = DOCX_MIME) {
  const updates: Record<string, unknown>[] = [];
  const prisma = {
    legalReviewRun: { update: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => (updates.push(data), Promise.resolve({}))) },
    npaDocument: { findMany: jest.fn().mockResolvedValue([{ sourceDate: new Date('2026-10-19') }, { sourceDate: null }]) },
  };
  const files = {
    readBufferForProcessing: jest.fn().mockImplementation(async () => ({ buffer: await contractDocx(), file: { mimeType } })),
    createGeneratedForEmployee: jest.fn().mockResolvedValue({ id: 'report1' }),
  };
  const realtime = { publish: jest.fn() };
  const service = new LegalReviewExecutionService(prisma as never, files as never, { review } as never, realtime as never);
  return { service, updates, files, realtime };
}

const REVIEW = {
  contract: 'Договор',
  gcRole: '',
  applicableActs: '',
  summary: 'Итог',
  findings: [{ risk: 'высокий', type: 'несоответствие НПА', verified: false, problems: ['x'], clause: 'п. 1', as_is: '', proposed: '', reasoning: '', gc_impact: '', norm_id: '', quote: '' }],
  generalIssues: [],
  notChecked: [],
  model: 'm',
  rounds: 4,
  durationMs: 1000,
};

describe('LegalReviewExecutionService.process', () => {
  it('успех: отчёт .docx сохранён на сотрудника, итог и счётчики в строке', async () => {
    const review = jest.fn().mockResolvedValue(REVIEW);
    const { service, updates, files, realtime } = make(review);
    await service.process(RUN);
    expect(review).toHaveBeenCalledWith(expect.stringContaining(CLAUSE), 'Договор.docx', null);
    expect(files.createGeneratedForEmployee).toHaveBeenCalledWith('u1', expect.any(Buffer), 'Разбор — Договор.docx', DOCX_MIME);
    expect(updates[0]).toMatchObject({ status: 'SUCCEEDED', reportFileId: 'report1', findingsCount: 1, unverifiedCount: 1, lockedAt: null });
    // rounds/durationMs — в лог, не в результат.
    expect(updates[0].result).not.toHaveProperty('rounds');
    expect(realtime.publish).toHaveBeenCalledWith('legal', 'u1');
  });

  it('ошибка агента — сразу FAILED с понятным текстом', async () => {
    const { service, updates } = make(jest.fn().mockRejectedValue(new LegalAgentError('TOO_MANY_ROUNDS', 'x')));
    await service.process(RUN);
    expect(updates[0]).toMatchObject({ status: 'FAILED', error: expect.stringContaining('не смог завершить разбор') });
  });

  it('неподдерживаемый файл — FAILED без вызова модели', async () => {
    const review = jest.fn();
    const { service, updates } = make(review, 'image/png');
    await service.process(RUN);
    expect(review).not.toHaveBeenCalled();
    expect(updates[0]).toMatchObject({ status: 'FAILED', error: 'Поддерживаются только договоры PDF и DOCX' });
  });

  it('сбой сети — обратно в очередь, пока есть попытки', async () => {
    const { service, updates } = make(jest.fn().mockRejectedValue(new Error('ECONNRESET')));
    await service.process(RUN);
    expect(updates[0]).toMatchObject({ status: 'QUEUED', error: 'Не удалось выполнить разбор — попробуйте позже' });

    const last = make(jest.fn().mockRejectedValue(new Error('ECONNRESET')));
    await last.service.process({ ...(RUN as object), attempts: MAX_REVIEW_ATTEMPTS } as never);
    expect(last.updates[0]).toMatchObject({ status: 'FAILED' });
  });
});
