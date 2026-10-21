import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { LegalReviewRun, LegalReviewStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { FilesService } from '../files/files.service';
import { RealtimeService } from '../realtime/realtime.service';
import { ContractTextError, extractContractText } from './contract-text';
import { LegalAgentError, LegalAgentService } from './legal-agent.service';
import { buildReviewDocx, DOCX_MIME, reportFileName } from './legal-report';

// Воркер разборов договоров — тот же приём, что AgentRun поездок
// (trip-run-execution.service.ts): строка в БД + @Cron + claim
// `FOR UPDATE SKIP LOCKED`. Разбор идёт 5–10 минут Opus, поэтому:
// - в процессе одновременно один разбор (память контейнера 512 МБ и деньги);
// - блокировка живёт 30 минут, потом задание считается брошенным;
// - не больше двух попыток: повтор — это ещё раз полная цена разбора.

const LOCK_TTL_MS = 30 * 60 * 1000;
export const MAX_REVIEW_ATTEMPTS = 2;
const GENERIC_FAILURE = 'Не удалось выполнить разбор — попробуйте позже';

// Безопасный текст ошибки для пользователя: ожидаемые отказы — своим
// сообщением, остальное — общей фразой (подробности только в лог).
function failureMessage(err: unknown): { message: string; permanent: boolean } {
  if (err instanceof ContractTextError) return { message: err.message, permanent: true };
  if (err instanceof LegalAgentError) {
    if (err.code === 'EMPTY_BASE') return { message: 'База НПА не загружена — обратитесь к администратору', permanent: true };
    return { message: 'Агент-юрист не смог завершить разбор — попробуйте ещё раз или сократите договор', permanent: true };
  }
  return { message: GENERIC_FAILURE, permanent: false };
}

@Injectable()
export class LegalReviewExecutionService {
  private readonly logger = new Logger(LegalReviewExecutionService.name);
  private busy = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly files: FilesService,
    private readonly agent: LegalAgentService,
    @Optional() private readonly realtime?: RealtimeService,
  ) {}

  @Cron(CronExpression.EVERY_10_SECONDS)
  async processPending(): Promise<void> {
    // @Cron не ждёт предыдущий запуск — разбор длиннее 10 с, не наслаиваем.
    if (this.busy) return;
    this.busy = true;
    try {
      await this.failExhausted();
      const run = await this.claimOne();
      if (run) await this.process(run);
    } finally {
      this.busy = false;
    }
  }

  // Брошенные задания (процесс упал посреди разбора) без оставшихся попыток
  // — FAILED, иначе висели бы RUNNING вечно.
  private async failExhausted(): Promise<void> {
    const threshold = new Date(Date.now() - LOCK_TTL_MS);
    const stale = await this.prisma.legalReviewRun.findMany({
      where: { status: LegalReviewStatus.RUNNING, lockedAt: { lt: threshold }, attempts: { gte: MAX_REVIEW_ATTEMPTS } },
      select: { id: true, employeeId: true },
    });
    for (const r of stale) {
      await this.prisma.legalReviewRun.update({
        where: { id: r.id },
        data: { status: LegalReviewStatus.FAILED, error: GENERIC_FAILURE, lockedAt: null, finishedAt: new Date() },
      });
      this.realtime?.publish('legal', r.employeeId);
    }
  }

  async claimOne(): Promise<LegalReviewRun | null> {
    const now = new Date();
    const threshold = new Date(now.getTime() - LOCK_TTL_MS);
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>(
        Prisma.sql`SELECT "id" FROM "LegalReviewRun"
          WHERE "attempts" < ${MAX_REVIEW_ATTEMPTS}
            AND ("status" = 'QUEUED' OR ("status" = 'RUNNING' AND "lockedAt" < ${threshold}))
          ORDER BY "createdAt" ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED`,
      );
      if (locked.length === 0) return null;
      return tx.legalReviewRun.update({
        where: { id: locked[0].id },
        data: { status: LegalReviewStatus.RUNNING, lockedAt: now, attempts: { increment: 1 }, startedAt: now, error: null },
      });
    });
  }

  async process(run: LegalReviewRun): Promise<void> {
    this.realtime?.publish('legal', run.employeeId);
    try {
      const { buffer, file } = await this.files.readBufferForProcessing(run.fileId);
      const text = await extractContractText(buffer, file.mimeType);
      const review = await this.agent.review(text, run.fileName, run.focus);

      const docs = await this.prisma.npaDocument.findMany({ select: { sourceDate: true } });
      const sourceDate = docs.map((d) => d.sourceDate).filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0];
      const docx = await buildReviewDocx(review, {
        fileName: run.fileName,
        documentsCount: docs.length,
        sourceDate: sourceDate ? sourceDate.toISOString().slice(0, 10) : null,
        createdAt: new Date(),
      });
      const report = await this.files.createGeneratedForEmployee(run.employeeId, docx, reportFileName(run.fileName), DOCX_MIME);

      const { rounds, durationMs, ...result } = review;
      await this.prisma.legalReviewRun.update({
        where: { id: run.id },
        data: {
          status: LegalReviewStatus.SUCCEEDED,
          result: result as unknown as Prisma.InputJsonValue,
          reportFileId: report.id,
          findingsCount: review.findings.length,
          unverifiedCount: review.findings.filter((f) => !f.verified).length,
          lockedAt: null,
          finishedAt: new Date(),
        },
      });
      this.logger.log(`legal review ${run.id}: ${review.findings.length} находок, ${rounds} раундов, ${Math.round(durationMs / 1000)} с`);
    } catch (err) {
      const { message, permanent } = failureMessage(err);
      this.logger.error(`legal review ${run.id} failed (attempt ${run.attempts}): ${err instanceof Error ? err.message : String(err)}`);
      const final = permanent || run.attempts >= MAX_REVIEW_ATTEMPTS;
      await this.prisma.legalReviewRun.update({
        where: { id: run.id },
        data: final
          ? { status: LegalReviewStatus.FAILED, error: message, lockedAt: null, finishedAt: new Date() }
          : { status: LegalReviewStatus.QUEUED, error: message, lockedAt: null },
      });
    }
    this.realtime?.publish('legal', run.employeeId);
  }
}
