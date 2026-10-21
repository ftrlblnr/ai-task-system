import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DOCX_MIME } from '../files/file-signature';
import { LegalReviewLimitError, LegalReviewService, MAX_ACTIVE_REVIEWS_PER_USER } from './legal-review.service';

const USER = { id: 'u1' } as never;
const row = (over: Record<string, unknown> = {}) => ({
  id: 'r1',
  employeeId: 'u1',
  status: 'QUEUED',
  fileId: 'f1',
  fileName: 'Договор.docx',
  focus: null,
  conversationId: null,
  reportFileId: null,
  findingsCount: null,
  unverifiedCount: null,
  error: null,
  result: null,
  createdAt: new Date('2026-10-21T10:00:00Z'),
  startedAt: null,
  finishedAt: null,
  ...over,
});

function make(opts: { existing?: unknown; mime?: string; active?: number } = {}) {
  const prisma = {
    legalReviewRun: {
      findUnique: jest.fn().mockResolvedValue(opts.existing ?? null),
      count: jest.fn().mockResolvedValue(opts.active ?? 0),
      create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve(row(data))),
      findMany: jest.fn().mockResolvedValue([row()]),
    },
  };
  const files = { assertOwnedFile: jest.fn().mockResolvedValue({ id: 'f1', name: 'Договор.docx', mimeType: opts.mime ?? DOCX_MIME }) };
  return { service: new LegalReviewService(prisma as never, files as never), prisma, files };
}

describe('LegalReviewService', () => {
  it('create: проверяет владение файлом и ставит разбор в очередь', async () => {
    const { service, prisma, files } = make();
    const { run, created } = await service.create(USER, { fileId: 'f1', focus: '  ', conversationId: 'c1', dedupeKey: 'k' });
    expect(created).toBe(true);
    expect(files.assertOwnedFile).toHaveBeenCalledWith(USER, 'f1');
    expect(prisma.legalReviewRun.create).toHaveBeenCalledWith({
      data: { employeeId: 'u1', conversationId: 'c1', fileId: 'f1', fileName: 'Договор.docx', focus: null, dedupeKey: 'k' },
    });
    expect(run.status).toBe('QUEUED');
  });

  it('create: повтор ключа — тот же разбор; чужой ключ — 400', async () => {
    const same = make({ existing: row() });
    expect(await same.service.create(USER, { fileId: 'f1', dedupeKey: 'k' })).toMatchObject({ created: false, run: { id: 'r1' } });
    expect(same.files.assertOwnedFile).not.toHaveBeenCalled();

    const other = make({ existing: row({ employeeId: 'u2' }) });
    await expect(other.service.create(USER, { fileId: 'f1', dedupeKey: 'k' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('create: не PDF/DOCX — LEGAL_UNSUPPORTED_FILE; лимит активных — 429', async () => {
    await expect(make({ mime: 'image/png' }).service.create(USER, { fileId: 'f1', dedupeKey: 'k' })).rejects.toMatchObject({
      response: { code: 'LEGAL_UNSUPPORTED_FILE' },
    });
    await expect(make({ active: MAX_ACTIVE_REVIEWS_PER_USER }).service.create(USER, { fileId: 'f1', dedupeKey: 'k' })).rejects.toBeInstanceOf(
      LegalReviewLimitError,
    );
  });

  it('create: гонка одинаковых запросов (P2002) — строка победителя', async () => {
    const { service, prisma } = make();
    prisma.legalReviewRun.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' }));
    prisma.legalReviewRun.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(row({ id: 'winner' }));
    expect(await service.create(USER, { fileId: 'f1', dedupeKey: 'k' })).toMatchObject({ created: false, run: { id: 'winner' } });
  });

  it('list — только свои, limit 1..50; get чужого — 404', async () => {
    const { service, prisma } = make({ existing: row({ employeeId: 'u2' }) });
    const list = await service.list(USER, 500);
    expect(prisma.legalReviewRun.findMany).toHaveBeenCalledWith({ where: { employeeId: 'u1' }, orderBy: { createdAt: 'desc' }, take: 50 });
    expect(list[0]).toMatchObject({ id: 'r1', createdAt: '2026-10-21T10:00:00.000Z', startedAt: null });
    await expect(service.get(USER, 'r1')).rejects.toBeInstanceOf(NotFoundException);
  });
});
