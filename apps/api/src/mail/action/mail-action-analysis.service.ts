import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import { PrismaService } from '../../prisma/prisma.service';
import { MailStore } from '../mail-store';
import {
  buildMailActionSystemPrompt,
  buildMailActionTool,
  buildMailActionUserContent,
  convertMailActionProposals,
  MailActionProposal,
  MAX_ANALYSIS_MESSAGES,
} from './mail-action-analysis';
import { MailActionPlanService } from './mail-action-plan.service';

// Haiku — та же модель, что mail-analysis.service.ts (классификация писем);
// задача того же порядка сложности (один structured-output вызов по
// готовому контексту, не агентный луп).
const MODEL = 'claude-haiku-4-5-20251001';

@Injectable()
export class MailActionAnalysisService {
  private readonly logger = new Logger(MailActionAnalysisService.name);
  private client: Anthropic | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly store: MailStore,
    private readonly plans: MailActionPlanService,
  ) {}

  private getClient(): Anthropic {
    if (!this.client) {
      this.client = new Anthropic({ apiKey: this.config.getOrThrow<string>('ANTHROPIC_API_KEY') });
    }
    return this.client;
  }

  // Вызывается сразу после создания плана (fire-and-forget из
  // MailActionController, как approveGroup → execution.start) — план
  // создаётся в статусе ANALYZING, HTTP-ответ не ждёт результат LLM.
  async analyzePlan(planId: string): Promise<void> {
    const plan = await this.prisma.mailActionPlan.findUniqueOrThrow({ where: { id: planId } });
    const scope = plan.scope as { folderPaths: string[] | null; since: string | null; until: string | null };

    const [allMessages, folders] = await Promise.all([
      this.store.listMessagesForActionAnalysis(plan.mailboxId, scope, MAX_ANALYSIS_MESSAGES),
      this.store.listFolders(plan.mailboxId),
    ]);
    // Папка без uidValidity (синк ещё не прошёл даже один цикл для неё) —
    // пропускаем: раздел 15 ТЗ требует точную координату, гадать нельзя.
    const messages = allMessages.filter((m) => m.folder.uidValidity !== null);

    if (messages.length === 0) {
      await this.plans.attachAnalysisResult(planId, [], { totalCandidates: 0, proposedCount: 0 });
      return;
    }

    try {
      const response = await this.getClient().messages.create({
        model: MODEL,
        max_tokens: 4096,
        system: buildMailActionSystemPrompt(),
        tools: [buildMailActionTool()],
        tool_choice: { type: 'tool', name: 'propose_mail_actions' },
        messages: [{ role: 'user', content: buildMailActionUserContent(plan.requestText, messages, folders) }],
      });

      const block = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
      if (!block) throw new Error('no tool_use block in response');
      const { actions } = block.input as { actions: MailActionProposal[] };

      const knownFolderPaths = new Set(folders.map((f) => f.path));
      const candidates = convertMailActionProposals(actions, messages, knownFolderPaths);

      await this.plans.attachAnalysisResult(planId, candidates, { totalCandidates: messages.length, proposedCount: candidates.length });
    } catch (err) {
      this.logger.error(`mail action analysis failed planId=${planId}: ${err instanceof Error ? err.message : String(err)}`);
      await this.plans.markAnalysisFailed(planId, err instanceof Error ? err.message : 'unknown error');
    }
  }
}
