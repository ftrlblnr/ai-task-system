import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import Anthropic from '@anthropic-ai/sdk';
import { MemorySource, MemoryStatus, MessageRole, Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AiUsageService, trackedCreate } from '../ai-usage/ai-usage.service';
import { buildSuggestTool, buildSuggestUserContent, parseSuggestions, SUGGEST_SYSTEM_PROMPT } from './memory-suggest';

const MODEL = 'claude-haiku-5-5';
const FIRST_SCAN_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_MESSAGES = 120;

// Раз в сутки (04:30 по Алматы) — после ответа модель не вызываем (план
// ARMS: «после каждого ответа не вызываем модель»). Прогресс — в
// MemoryScanState: упавший запуск следующей ночью возьмёт те же сообщения.
@Injectable()
export class MemorySuggestService {
  private readonly logger = new Logger(MemorySuggestService.name);
  private client: Anthropic | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Optional() private readonly aiUsage?: AiUsageService,
  ) {}

  private getClient(): Anthropic {
    if (!this.client) this.client = new Anthropic({ apiKey: this.config.getOrThrow<string>('ANTHROPIC_API_KEY') });
    return this.client;
  }

  @Cron('0 30 23 * * *')
  async runDaily(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const owners = await this.prisma.employee.findMany({ where: { role: { in: [Role.OWNER, Role.ADMIN] }, status: 'ACTIVE' }, select: { id: true } });
      for (const owner of owners) {
        try {
          await this.suggestFor(owner.id);
        } catch (err) {
          this.logger.warn(`memory suggest owner=${owner.id} failed: ${err instanceof Error ? err.message : 'unknown'}`);
        }
      }
    } finally {
      this.running = false;
    }
  }

  // Возвращает число созданных предложений.
  async suggestFor(ownerId: string, now = new Date()): Promise<number> {
    const state = await this.prisma.memoryScanState.findUnique({ where: { ownerId } });
    const since = state?.scannedUpTo ?? new Date(now.getTime() - FIRST_SCAN_WINDOW_MS);
    const messages = await this.prisma.message.findMany({
      where: { role: MessageRole.USER, createdAt: { gt: since, lte: now }, conversation: { employeeId: ownerId } },
      orderBy: { createdAt: 'asc' },
      take: MAX_MESSAGES,
      include: { parts: { where: { type: 'MARKDOWN' }, orderBy: { order: 'asc' } } },
    });
    const texts = messages
      .map((m) => m.parts.map((p) => (p.data as { content?: unknown })?.content).filter((c): c is string => typeof c === 'string').join(' '))
      .filter((t) => t.trim().length >= 8);
    const scannedUpTo = messages.length === MAX_MESSAGES ? messages[messages.length - 1].createdAt : now;

    let created = 0;
    if (texts.length > 0) {
      const known = (await this.prisma.memoryItem.findMany({ where: { ownerId }, select: { text: true }, orderBy: { updatedAt: 'desc' }, take: 300 })).map((k) => k.text);
      const response = await trackedCreate(this.aiUsage, 'memory.suggest', this.getClient(), {
        model: MODEL,
        max_tokens: 2048,
        system: SUGGEST_SYSTEM_PROMPT,
        tools: [buildSuggestTool()],
        tool_choice: { type: 'tool', name: 'suggest_memory' },
        messages: [{ role: 'user', content: buildSuggestUserContent(texts, known) }],
      });
      const block = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
      const suggestions = parseSuggestions(block?.input, known);
      if (suggestions.length > 0) {
        const result = await this.prisma.memoryItem.createMany({
          data: suggestions.map((s) => ({ ownerId, kind: s.kind, text: s.text, source: MemorySource.SUGGESTED, status: MemoryStatus.PENDING })),
        });
        created = result.count;
      }
    }
    await this.prisma.memoryScanState.upsert({ where: { ownerId }, create: { ownerId, scannedUpTo }, update: { scannedUpTo } });
    if (created > 0) this.logger.log(`memory suggest owner=${ownerId} suggested=${created}`);
    return created;
  }
}
