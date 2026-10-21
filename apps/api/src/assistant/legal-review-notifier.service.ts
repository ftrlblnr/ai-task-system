import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { LegalReviewStatus, MessagePartType, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { formatReviewSummary, type LegalReview } from '../legal/legal-agent';
import { AssistantChatService } from './assistant-chat.service';
import type { MessagePartInput } from './assistant-render';

// Итог разбора договора, запущенного из чата, — сообщением в ту же беседу
// (handoff, раздел 3.3). Отдельно от воркера (legal/): LegalModule не
// зависит от ассистента, а доставка переживает перезапуск — разбор отмечен
// в БД (finishedAt), доставка — notifiedAt в одной транзакции с сообщением.

const BATCH = 10;

@Injectable()
export class LegalReviewNotifier {
  private readonly logger = new Logger(LegalReviewNotifier.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly chat: AssistantChatService,
    @Optional() private readonly realtime?: RealtimeService,
  ) {}

  @Cron(CronExpression.EVERY_10_SECONDS)
  async deliverFinished(): Promise<void> {
    const runs = await this.prisma.legalReviewRun.findMany({
      where: {
        conversationId: { not: null },
        notifiedAt: null,
        status: { in: [LegalReviewStatus.SUCCEEDED, LegalReviewStatus.FAILED] },
      },
      orderBy: { finishedAt: 'asc' },
      take: BATCH,
    });
    for (const run of runs) {
      try {
        const { parts, fileIds } = await this.buildMessage(run);
        const claim = async (tx: Prisma.TransactionClient) =>
          (await tx.legalReviewRun.updateMany({ where: { id: run.id, notifiedAt: null }, data: { notifiedAt: new Date() } })).count === 1;
        const delivered = await this.chat.appendBackgroundMessage(run.conversationId!, parts, fileIds, claim);
        if (!delivered) {
          // Беседу удалили — отмечаем, чтобы не перебирать вечно.
          await this.prisma.legalReviewRun.updateMany({ where: { id: run.id, notifiedAt: null }, data: { notifiedAt: new Date() } });
        }
        this.realtime?.publish('assistant', run.employeeId);
      } catch (err) {
        this.logger.error(`legal review ${run.id}: доставка в беседу не удалась: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private async buildMessage(run: {
    status: LegalReviewStatus;
    fileName: string;
    result: Prisma.JsonValue;
    reportFileId: string | null;
    error: string | null;
  }): Promise<{ parts: MessagePartInput[]; fileIds: string[] }> {
    if (run.status !== LegalReviewStatus.SUCCEEDED || !run.result || !run.reportFileId) {
      const text = `**Разбор договора «${run.fileName}» не выполнен.** ${run.error ?? 'Попробуйте запустить его ещё раз.'}`;
      return { parts: [{ type: MessagePartType.MARKDOWN, order: 0, data: { content: text } }], fileIds: [] };
    }
    const review = run.result as unknown as LegalReview;
    const parts: MessagePartInput[] = [{ type: MessagePartType.MARKDOWN, order: 0, data: { content: formatReviewSummary(review, run.fileName) } }];
    const file = await this.prisma.fileArtifact.findUnique({ where: { id: run.reportFileId } });
    if (!file) return { parts, fileIds: [] };
    parts.push({
      type: MessagePartType.FILE,
      order: 1,
      data: { fileId: file.id, name: file.name, mimeType: file.mimeType, size: file.size },
    });
    return { parts, fileIds: [file.id] };
  }
}
