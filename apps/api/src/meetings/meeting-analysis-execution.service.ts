import { HttpException, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { MeetingAnalysisRun, MeetingAnalysisStatus, MeetingProposalStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { MeetingTaskExtractionService, type MeetingTaskDraft } from './meeting-task-extraction.service';
import { analysisInputHash, MeetingAnalysisService } from './meeting-analysis.service';
import { MeetingsService } from './meetings.service';
import { hasSpeakerNames, MeetingSpeakersService, shouldAutoApply, speakerLabels, type SpeakerSuggestion } from './meeting-speakers.service';

// Воркер разбора встреч — тот же приём, что LegalReviewRun
// (legal-review-execution.service.ts): строка в БД + @Cron + claim
// `FOR UPDATE SKIP LOCKED`. Один разбор за раз (Opus, деньги и память
// контейнера), блокировка 15 минут, две попытки — повтор стоит ещё одного
// полного разбора.
//
// Шаги: говорящие (B.3, MeetingSpeakersService) → поручения. Поручения
// пока извлекаются прежним MeetingTaskExtractionService по саммари; разбор
// расшифровки со ссылками на реплики (B3) заменит этот шаг.

const LOCK_TTL_MS = 15 * 60 * 1000;
export const MAX_ANALYSIS_ATTEMPTS = 2;
const GENERIC_FAILURE = 'Не удалось разобрать запись — попробуйте ещё раз позже';

// Ошибки извлечения — HttpException с понятным текстом («Встреча слишком
// длинная…») и повтором не лечатся; остальное — сбой сети/API, повторяем.
function failureMessage(err: unknown): { message: string; permanent: boolean } {
  if (err instanceof HttpException) return { message: err.message, permanent: true };
  return { message: GENERIC_FAILURE, permanent: false };
}

function parseDueDate(value: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function toProposalRows(meetingId: string, runId: string, drafts: MeetingTaskDraft[]): Prisma.MeetingProposalCreateManyInput[] {
  return drafts.map((d, i) => ({
    meetingId,
    runId,
    order: i,
    title: d.title,
    description: d.description,
    assigneeId: d.assigneeId,
    dueDate: parseDueDate(d.dueDate),
    priority: d.priority,
    confidence: d.confidence,
    sourceContext: d.sourceContext,
  }));
}

@Injectable()
export class MeetingAnalysisExecutionService {
  private readonly logger = new Logger(MeetingAnalysisExecutionService.name);
  private busy = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly analysis: MeetingAnalysisService,
    private readonly extraction: MeetingTaskExtractionService,
    private readonly meetings: MeetingsService,
    private readonly speakers: MeetingSpeakersService,
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

  // Брошенные запуски (процесс упал посреди разбора) без оставшихся попыток
  // — FAILED, иначе кнопка навсегда показывала бы «Разбираю запись…».
  private async failExhausted(): Promise<void> {
    const threshold = new Date(Date.now() - LOCK_TTL_MS);
    await this.prisma.meetingAnalysisRun.updateMany({
      where: { status: MeetingAnalysisStatus.RUNNING, lockedAt: { lt: threshold }, attempts: { gte: MAX_ANALYSIS_ATTEMPTS } },
      data: { status: MeetingAnalysisStatus.FAILED, error: GENERIC_FAILURE, lockedAt: null, finishedAt: new Date() },
    });
  }

  async claimOne(): Promise<MeetingAnalysisRun | null> {
    const now = new Date();
    const threshold = new Date(now.getTime() - LOCK_TTL_MS);
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>(
        Prisma.sql`SELECT "id" FROM "MeetingAnalysisRun"
          WHERE "attempts" < ${MAX_ANALYSIS_ATTEMPTS}
            AND ("status" = 'QUEUED' OR ("status" = 'RUNNING' AND "lockedAt" < ${threshold}))
          ORDER BY "createdAt" ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED`,
      );
      if (locked.length === 0) return null;
      return tx.meetingAnalysisRun.update({
        where: { id: locked[0].id },
        data: { status: MeetingAnalysisStatus.RUNNING, lockedAt: now, attempts: { increment: 1 }, startedAt: now, error: null },
      });
    });
  }

  async process(run: MeetingAnalysisRun): Promise<void> {
    try {
      const meeting = await this.prisma.meeting.findUnique({
        where: { id: run.meetingId },
        select: { title: true, meetingDate: true, createdById: true, speakerNames: true },
      });
      // Встречу удалили, пока запуск стоял в очереди, — строка запуска ушла
      // каскадом вместе с ней, писать некуда.
      if (!meeting) return;

      const speakerSuggestions = await this.matchSpeakers(run, meeting);
      // Вход читается ПОСЛЕ шага говорящих: применённые имена уже в
      // enhancedSummary, извлечение видит людей, а не «Speaker 2».
      const input = await this.analysis.loadInput(run.meetingId);
      if (!input) return;

      const employees = await this.prisma.employee.findMany({ where: { status: 'ACTIVE' }, select: { id: true, fullName: true } });
      const drafts = await this.extraction.extract(input.summary, meeting.title, meeting.meetingDate.toLocaleDateString('ru-RU'), employees);

      // Одной транзакцией: неутверждённые предложения прошлых разборов
      // заменяются новыми (APPROVED/REJECTED — уже решения руководителя, их
      // не трогаем), запуск — DONE. Пока новый разбор идёт или упал,
      // прежний список остаётся на месте.
      await this.prisma.$transaction(async (tx) => {
        await tx.meetingProposal.updateMany({
          where: { meetingId: run.meetingId, runId: { not: run.id }, status: MeetingProposalStatus.PROPOSED },
          data: { status: MeetingProposalStatus.SUPERSEDED },
        });
        if (drafts.length > 0) {
          await tx.meetingProposal.createMany({ data: toProposalRows(run.meetingId, run.id, drafts) });
        }
        await tx.meetingAnalysisRun.update({
          where: { id: run.id },
          data: {
            status: MeetingAnalysisStatus.DONE,
            // Хэш того, что реально разобрано: после применения имён
            // саммари другое, и без этого кнопка решила бы, что запись
            // изменилась.
            inputHash: analysisInputHash(input),
            speakerSuggestions: speakerSuggestions ? (speakerSuggestions as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
            lockedAt: null,
            finishedAt: new Date(),
          },
        });
      });

      // Запуск уже DONE — сбой аудита не должен вернуть его в очередь
      // (catch ниже) и оплатить второй разбор.
      if (run.requestedById) {
        await this.audit
          .log(run.requestedById, 'AI_MEETING_EXTRACT', 'Meeting', run.meetingId, { runId: run.id, proposalCount: drafts.length })
          .catch((err: unknown) => this.logger.warn(`meeting analysis ${run.id}: аудит не записан: ${String(err)}`));
      }
      this.logger.log(`meeting analysis ${run.id}: поручений — ${drafts.length}`);
    } catch (err) {
      const { message, permanent } = failureMessage(err);
      this.logger.error(`meeting analysis ${run.id} failed (attempt ${run.attempts}): ${err instanceof Error ? err.message : String(err)}`);
      const final = permanent || run.attempts >= MAX_ANALYSIS_ATTEMPTS;
      // updateMany — встречу могли удалить посреди разбора.
      await this.prisma.meetingAnalysisRun.updateMany({
        where: { id: run.id },
        data: final
          ? { status: MeetingAnalysisStatus.FAILED, error: message, lockedAt: null, finishedAt: new Date() }
          : { status: MeetingAnalysisStatus.QUEUED, error: message, lockedAt: null },
      });
    }
  }

  // Шаг 1 — говорящие (B.3). null — шаг не делался: имена уже есть (их не
  // перезаписываем), нет расшифровки или сбой. Best-effort: без имён
  // поручения всё равно извлекаются, просто исполнители реже сопоставлены.
  private async matchSpeakers(
    run: MeetingAnalysisRun,
    meeting: { title: string; meetingDate: Date; createdById: string; speakerNames: Prisma.JsonValue },
  ): Promise<SpeakerSuggestion[] | null> {
    if (hasSpeakerNames(meeting.speakerNames)) return null;
    const segments = await this.prisma.meetingSegment.findMany({
      where: { meetingId: run.meetingId },
      orderBy: { order: 'asc' },
      select: { speakerLabel: true, startMs: true, text: true },
    });
    if (segments.length === 0) return null;

    try {
      const suggestions = await this.speakers.suggest(meeting, segments);
      if (!shouldAutoApply(speakerLabels(segments), suggestions)) return suggestions;
      // Пока модель думала, руководитель мог вписать имена сам — его ввод важнее.
      const fresh = await this.prisma.meeting.findUnique({ where: { id: run.meetingId }, select: { speakerNames: true } });
      if (!fresh || hasSpeakerNames(fresh.speakerNames)) return suggestions;
      await this.meetings.updateSpeakers(run.meetingId, Object.fromEntries(suggestions.map((s) => [s.label, s.name ?? ''])));
      return suggestions.map((s) => ({ ...s, applied: true }));
    } catch (err) {
      this.logger.warn(`meeting analysis ${run.id}: говорящие не сопоставлены: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }
}
