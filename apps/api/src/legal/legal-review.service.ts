import { BadRequestException, HttpException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { LegalReviewRun, LegalReviewStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { FilesService } from '../files/files.service';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { isContractMimeType } from './contract-text';
import type { LegalReview } from './legal-agent';

// Постановка и чтение разборов договоров (handoff, раздел 3.2). Сам разбор
// — фоновый воркер legal-review-execution.service.ts.

// Разбор — $1–2 и несколько минут Opus; больше трёх одновременных у одного
// человека — почти наверняка двойной клик или зацикливание модели чата.
export const MAX_ACTIVE_REVIEWS_PER_USER = 3;
const ACTIVE: LegalReviewStatus[] = [LegalReviewStatus.QUEUED, LegalReviewStatus.RUNNING];

export interface CreateReviewInput {
  fileId: string;
  focus?: string | null;
  conversationId?: string | null;
  dedupeKey: string;
}

export interface LegalReviewView {
  id: string;
  status: LegalReviewStatus;
  fileId: string;
  fileName: string;
  focus: string | null;
  conversationId: string | null;
  reportFileId: string | null;
  findingsCount: number | null;
  unverifiedCount: number | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface LegalReviewDetail extends LegalReviewView {
  result: LegalReview | null;
}

export function toReviewView(r: LegalReviewRun): LegalReviewView {
  return {
    id: r.id,
    status: r.status,
    fileId: r.fileId,
    fileName: r.fileName,
    focus: r.focus,
    conversationId: r.conversationId,
    reportFileId: r.reportFileId,
    findingsCount: r.findingsCount,
    unverifiedCount: r.unverifiedCount,
    error: r.error,
    createdAt: r.createdAt.toISOString(),
    startedAt: r.startedAt?.toISOString() ?? null,
    finishedAt: r.finishedAt?.toISOString() ?? null,
  };
}

export class LegalReviewLimitError extends HttpException {
  constructor() {
    super(
      { code: 'LEGAL_REVIEW_LIMIT', message: `Уже идут ${MAX_ACTIVE_REVIEWS_PER_USER} разбора — дождитесь их завершения` },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

@Injectable()
export class LegalReviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly files: FilesService,
  ) {}

  // Владение файлом — assertOwnedFile (fileId от модели чата или клиента —
  // не право на файл). Повтор с тем же dedupeKey возвращает уже созданный
  // разбор, а не ставит второй.
  async create(user: AuthenticatedUser, input: CreateReviewInput): Promise<{ run: LegalReviewRun; created: boolean }> {
    const existing = await this.prisma.legalReviewRun.findUnique({ where: { dedupeKey: input.dedupeKey } });
    if (existing) {
      if (existing.employeeId !== user.id) throw new BadRequestException('Ключ идемпотентности уже использован');
      return { run: existing, created: false };
    }

    const file = await this.files.assertOwnedFile(user, input.fileId);
    if (!isContractMimeType(file.mimeType)) {
      throw new BadRequestException({ code: 'LEGAL_UNSUPPORTED_FILE', message: 'Для разбора нужен договор в PDF или DOCX' });
    }
    const active = await this.prisma.legalReviewRun.count({ where: { employeeId: user.id, status: { in: ACTIVE } } });
    if (active >= MAX_ACTIVE_REVIEWS_PER_USER) throw new LegalReviewLimitError();

    try {
      const run = await this.prisma.legalReviewRun.create({
        data: {
          employeeId: user.id,
          conversationId: input.conversationId ?? null,
          fileId: file.id,
          fileName: file.name,
          focus: input.focus?.trim() || null,
          dedupeKey: input.dedupeKey,
        },
      });
      return { run, created: true };
    } catch (err) {
      // Гонка двух одинаковых запросов: проигравший берёт строку победителя.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const winner = await this.prisma.legalReviewRun.findUnique({ where: { dedupeKey: input.dedupeKey } });
        if (winner && winner.employeeId === user.id) return { run: winner, created: false };
      }
      throw err;
    }
  }

  async list(user: AuthenticatedUser, limit = 20): Promise<LegalReviewView[]> {
    const rows = await this.prisma.legalReviewRun.findMany({
      where: { employeeId: user.id },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 50),
    });
    return rows.map(toReviewView);
  }

  // Чужой разбор — 404, как чужой файл (FilesService.assertOwnedFile).
  async get(user: AuthenticatedUser, id: string): Promise<LegalReviewDetail> {
    const run = await this.prisma.legalReviewRun.findUnique({ where: { id } });
    if (!run || run.employeeId !== user.id) throw new NotFoundException('Разбор не найден');
    return { ...toReviewView(run), result: (run.result as unknown as LegalReview | null) ?? null };
  }
}
