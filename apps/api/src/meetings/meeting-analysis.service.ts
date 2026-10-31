import { createHash } from 'node:crypto';
import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { MeetingAnalysisStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { SpeakerSuggestion } from './meeting-speakers.service';

// Поручения из встреч (AGENT_AND_MEETINGS.md, B.2). Разбор запускает только
// руководитель — кнопкой на странице встречи или фразой ассистенту (решение
// владельца 01.11.2026: не все записи требуют задач). PlaudSyncService сюда
// не ходит, автозапуска нет. Сам разбор — в MeetingAnalysisExecutionService.

const ACTIVE_STATUSES: MeetingAnalysisStatus[] = [MeetingAnalysisStatus.QUEUED, MeetingAnalysisStatus.RUNNING];

export interface MeetingAnalysisInput {
  summary: string;
  segments: { id: string; text: string }[];
}

// Тот же порядок полей, что видит модель: саммари, затем реплики по порядку.
export function analysisInputHash(input: MeetingAnalysisInput): string {
  const hash = createHash('sha256').update(input.summary);
  for (const s of input.segments) hash.update(`\n${s.id}\t${s.text}`);
  return hash.digest('hex');
}

export function currentSummary(meeting: { enhancedSummary: string | null; latestSummary: string | null; rawSummary: string }): string {
  return meeting.enhancedSummary ?? meeting.latestSummary ?? meeting.rawSummary;
}

export interface MeetingAnalysisState {
  runId: string;
  status: MeetingAnalysisStatus;
  hadTranscript: boolean;
  error: string | null;
  createdAt: Date;
  finishedAt: Date | null;
  // Запись изменилась с последнего успешного разбора — для «Запись не
  // менялась. Разобрать ещё раз?» на кнопке.
  inputChanged: boolean;
  // Подсказки «Speaker 2 — это …» для формы имён; null — шаг не делался.
  speakerSuggestions: SpeakerSuggestion[] | null;
}

@Injectable()
export class MeetingAnalysisService {
  constructor(private readonly prisma: PrismaService) {}

  async loadInput(meetingId: string): Promise<MeetingAnalysisInput | null> {
    const meeting = await this.prisma.meeting.findUnique({
      where: { id: meetingId },
      select: { rawSummary: true, latestSummary: true, enhancedSummary: true },
    });
    if (!meeting) return null;
    const segments = await this.prisma.meetingSegment.findMany({
      where: { meetingId },
      orderBy: { order: 'asc' },
      select: { id: true, text: true },
    });
    return { summary: currentSummary(meeting), segments };
  }

  async start(meetingId: string, requestedById: string) {
    const input = await this.loadInput(meetingId);
    if (!input) throw new NotFoundException('Встреча не найдена');
    if (!input.summary.trim() && input.segments.length === 0) {
      throw new UnprocessableEntityException('NOTHING_TO_ANALYZE: у встречи нет ни саммари, ни расшифровки');
    }

    // Блокировка строки встречи — два одновременных нажатия (разные
    // вкладки, кнопка и ассистент) не поставят два платных разбора: второй
    // ждёт первого и видит его QUEUED. Idempotency-Key ловит только повтор
    // одного и того же запроса.
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Meeting" WHERE "id" = ${meetingId} FOR UPDATE`;
      const active = await tx.meetingAnalysisRun.findFirst({
        where: { meetingId, status: { in: ACTIVE_STATUSES } },
        select: { id: true },
      });
      if (active) throw new ConflictException('ANALYSIS_IN_PROGRESS: разбор этой встречи уже идёт');

      const run = await tx.meetingAnalysisRun.create({
        data: { meetingId, requestedById, inputHash: analysisInputHash(input), hadTranscript: input.segments.length > 0 },
        select: { id: true, status: true, hadTranscript: true },
      });
      return { runId: run.id, status: run.status, hadTranscript: run.hadTranscript };
    });
  }

  // Последний запуск встречи; null — разбор ещё ни разу не запускали.
  async latest(meetingId: string): Promise<MeetingAnalysisState | null> {
    const run = await this.prisma.meetingAnalysisRun.findFirst({ where: { meetingId }, orderBy: { createdAt: 'desc' } });
    if (!run) return null;

    const lastDone =
      run.status === MeetingAnalysisStatus.DONE
        ? run
        : await this.prisma.meetingAnalysisRun.findFirst({
            where: { meetingId, status: MeetingAnalysisStatus.DONE },
            orderBy: { createdAt: 'desc' },
            select: { inputHash: true },
          });
    const input = lastDone ? await this.loadInput(meetingId) : null;

    return {
      runId: run.id,
      status: run.status,
      hadTranscript: run.hadTranscript,
      error: run.error,
      createdAt: run.createdAt,
      finishedAt: run.finishedAt,
      inputChanged: !lastDone || !input || analysisInputHash(input) !== lastDone.inputHash,
      speakerSuggestions: Array.isArray(run.speakerSuggestions) ? (run.speakerSuggestions as unknown as SpeakerSuggestion[]) : null,
    };
  }
}
