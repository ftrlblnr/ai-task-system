import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import {
  buildAnalysisSystemPrompt,
  buildAnalysisTool,
  buildAnalysisUserContent,
  computeAnalysisInputHash,
  type EmailAnalysisDraft,
  type EmailAnalysisInput,
} from './mail-analysis';
import { MailStore, type MessageForAnalysis } from './mail-store';

// Один forced tool-use вызов на письмо (не агентный луп) — Haiku, та же
// модель, что уже в проде через voice/draft-extraction.service.ts. Задача
// (классификация одного письма) заметно проще, чем извлечение задач из
// саммари встречи (meeting-task-extraction.service.ts, Opus) — каскад на
// Opus здесь не нужен.
const MODEL = 'claude-haiku-4-5-20251001';

// Потолок на прогон — тот же принцип самоограничения, что MAX_MESSAGES_PER_RUN
// в MailSyncService: большой бэклог после первого подключения ящика догоняется
// за несколько тиков cron, а не платит всей стоимостью и временем сразу.
export const MAX_ANALYSIS_PER_RUN = 20;
// Ограничивает ретраи структурно «битых» писем (например, из-за сбойной
// кодировки) — без потолка такое письмо жгло бы вызовы каждый тик вечно.
export const MAX_ANALYSIS_ATTEMPTS = 3;

@Injectable()
export class MailAnalysisService {
  private readonly logger = new Logger(MailAnalysisService.name);
  private client: Anthropic | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly store: MailStore,
  ) {}

  // Ленивая инициализация — отсутствие ANTHROPIC_API_KEY не должно ронять
  // весь процесс api при старте (тот же приём, что в остальных LLM-сервисах).
  private getClient(): Anthropic {
    if (!this.client) {
      this.client = new Anthropic({ apiKey: this.config.getOrThrow<string>('ANTHROPIC_API_KEY') });
    }
    return this.client;
  }

  async analyzeBacklog(mailboxId: string): Promise<{ analyzed: number; failed: number }> {
    const candidates = await this.store.listMessagesForAnalysis(mailboxId, MAX_ANALYSIS_ATTEMPTS, MAX_ANALYSIS_PER_RUN);
    let analyzed = 0;
    let failed = 0;
    const touchedThreads = new Set<string>();

    for (const message of candidates) {
      const ok = await this.analyzeOne(message);
      if (ok) analyzed++;
      else failed++;
      if (message.threadId) touchedThreads.add(message.threadId);
    }
    for (const threadId of touchedThreads) await this.store.refreshThread(threadId);

    if (candidates.length > 0) {
      this.logger.log(`mail analysis mailbox=${mailboxId} analyzed=${analyzed} failed=${failed}`);
    }
    return { analyzed, failed };
  }

  private toAnalysisInput(message: MessageForAnalysis): EmailAnalysisInput {
    return {
      subject: message.subject,
      fromAddress: message.fromAddress,
      fromName: message.fromName,
      sentAt: message.sentAt,
      receivedAt: message.receivedAt,
      to: message.recipients.filter((r) => r.type === 'TO').map((r) => r.address),
      cc: message.recipients.filter((r) => r.type === 'CC').map((r) => r.address),
      textBody: message.textBody,
      attachments: message.attachments,
    };
  }

  private async analyzeOne(message: MessageForAnalysis): Promise<boolean> {
    const input = this.toAnalysisInput(message);
    try {
      const response = await this.getClient().messages.create({
        model: MODEL,
        max_tokens: 1024,
        system: buildAnalysisSystemPrompt(),
        tools: [buildAnalysisTool()],
        tool_choice: { type: 'tool', name: 'analyze_email' },
        messages: [{ role: 'user', content: buildAnalysisUserContent(input) }],
      });

      const block = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
      if (!block) throw new Error('no tool_use block in response');
      const draft = block.input as EmailAnalysisDraft;

      await this.store.recordAnalysisSuccess(message.id, {
        summary: draft.summary,
        importance: draft.importance,
        category: draft.category,
        needsReply: draft.needsReply,
        needsAction: draft.needsAction,
        actionSummary: draft.actionSummary,
        deadline: draft.deadline ? new Date(draft.deadline) : null,
        inputHash: computeAnalysisInputHash(input),
        model: MODEL,
      });
      return true;
    } catch (err) {
      this.logger.warn(`mail analysis failed messageId=${message.id}: ${err instanceof Error ? err.message : 'unknown'}`);
      await this.store.recordAnalysisFailure(message.id);
      return false;
    }
  }
}
