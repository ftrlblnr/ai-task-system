import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import type Anthropic from '@anthropic-ai/sdk';
import { Prisma } from '@prisma/client';
import type { AiUsageGroupBy, AiUsageSummary } from '@ai-task-system/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { TIMEZONE_OFFSET_HOURS, localDateString } from '../common/timezone';
import { PRICES_AS_OF } from './ai-usage-prices';
import { summarizeAiCalls } from './ai-usage-summary';

// Журнал вызовов ИИ (владелец 21.10.2026: «производительность и
// оптимизация») — время ответа, токены и кэш по каждой функции, чтобы
// решения о моделях и промптах принимались по цифрам. Запись — fire-and-forget:
// сбой журнала не должен ронять сам вызов.
const RETENTION_DAYS = 90;

export interface AiCallEntry {
  feature: string;
  model: string;
  latencyMs: number;
  ok: boolean;
  firstTokenMs?: number | null;
  usage?: Anthropic.Usage | null;
  audioMs?: number | null;
  error?: string | null;
  meta?: Record<string, unknown> | null;
}

@Injectable()
export class AiUsageService {
  private readonly logger = new Logger(AiUsageService.name);

  constructor(private readonly prisma: PrismaService) {}

  record(entry: AiCallEntry): void {
    this.prisma.aiCall
      .create({
        data: {
          feature: entry.feature,
          model: entry.model,
          latencyMs: Math.round(entry.latencyMs),
          firstTokenMs: entry.firstTokenMs != null ? Math.round(entry.firstTokenMs) : null,
          inputTokens: entry.usage?.input_tokens ?? null,
          outputTokens: entry.usage?.output_tokens ?? null,
          cacheReadTokens: entry.usage?.cache_read_input_tokens ?? null,
          cacheWriteTokens: entry.usage?.cache_creation_input_tokens ?? null,
          audioMs: entry.audioMs ?? null,
          ok: entry.ok,
          error: entry.error ? entry.error.slice(0, 300) : null,
          meta: entry.meta ? (entry.meta as Prisma.InputJsonValue) : undefined,
        },
      })
      .catch((err: unknown) => this.logger.warn(`ai call log failed: ${err instanceof Error ? err.message : 'unknown'}`));
  }

  // Обёртка для messages.create(): время и usage пишутся и при успехе, и при сбое.
  async track(feature: string, model: string, call: () => Promise<Anthropic.Message>): Promise<Anthropic.Message> {
    const started = Date.now();
    try {
      const response = await call();
      this.record({
        feature,
        model,
        latencyMs: Date.now() - started,
        ok: true,
        usage: response.usage,
      });
      return response;
    } catch (err) {
      this.record({
        feature,
        model,
        latencyMs: Date.now() - started,
        ok: false,
        error: errorText(err),
      });
      throw err;
    }
  }

  // Экран «Расход ИИ» (ARMS, фаза 2): период — последние `days` дней по
  // времени компании, включая сегодня. Строк за 30 дней — тысячи, не
  // миллионы (журнал хранит 90 дней), поэтому сводка считается в памяти.
  async summary(days: number, groupBy: AiUsageGroupBy): Promise<AiUsageSummary> {
    const to = new Date();
    const todayStartUtc = new Date(`${localDateString(to)}T00:00:00.000Z`).getTime() - TIMEZONE_OFFSET_HOURS * 3_600_000;
    const from = new Date(todayStartUtc - (days - 1) * 86_400_000);
    const [calls, lastByFeature] = await Promise.all([
      this.prisma.aiCall.findMany({
        where: { createdAt: { gte: from } },
        select: {
          feature: true,
          model: true,
          latencyMs: true,
          inputTokens: true,
          outputTokens: true,
          cacheReadTokens: true,
          cacheWriteTokens: true,
          audioMs: true,
          ok: true,
          createdAt: true,
        },
      }),
      this.prisma.aiCall.groupBy({ by: ['feature'], _max: { createdAt: true } }),
    ]);
    return summarizeAiCalls({
      calls,
      groupBy,
      days,
      from,
      to,
      pricesAsOf: PRICES_AS_OF,
      lastCallByFeature: lastByFeature.flatMap((f) => (f._max.createdAt ? [{ feature: f.feature, lastCallAt: f._max.createdAt }] : [])),
    });
  }

  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async purgeOld(): Promise<void> {
    const before = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
    await this.prisma.aiCall.deleteMany({
      where: { createdAt: { lt: before } },
    });
  }
}

export function errorText(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : 'unknown';
}

// messages.create() с записью в журнал; aiUsage необязателен — юнит-тесты
// сервисов создают их без него.
export function trackedCreate(
  aiUsage: AiUsageService | undefined,
  feature: string,
  client: Anthropic,
  params: Anthropic.MessageCreateParamsNonStreaming,
): Promise<Anthropic.Message> {
  const call = () => client.messages.create(params);
  return aiUsage ? aiUsage.track(feature, params.model, call) : call();
}
