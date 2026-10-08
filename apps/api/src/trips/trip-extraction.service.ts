import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import { FilesService } from '../files/files.service';
import { buildExtractionSystemPrompt, buildExtractionTool, buildMaterialContentBlock, isExtractableMimeType, type TripExtractionDraft } from './trip-extraction';

// Один forced tool-use вызов на материал (не агентный луп) — тот же приём,
// что mail/mail-analysis.service.ts. Haiku достаточно: задача — структурное
// извлечение заведомо присутствующих в документе фактов, не рассуждение.
const MODEL = 'claude-haiku-4-5-20251001';

export type TripMaterialExtractionOutcome =
  | { status: 'EXTRACTED'; draft: TripExtractionDraft; fileName: string }
  | { status: 'UNREADABLE'; issue: string; fileName: string }
  | { status: 'FAILED'; issue: string; fileName: string };

// Агент поездок (ТЗ 08.10.2026, раздел 7/18) — вызов модели для ОДНОГО
// материала. Чтение байт — через FilesService.readBufferForProcessing (нет
// живого AuthenticatedUser в фоновом воркере, см. комментарий там же).
// Сервис НЕ пишет в БД сам (в отличие от MailAnalysisService) — результат
// возвращается вызывающему коду (trip-run-execution.service.ts), которому
// нужен сам draft для последующей сборки карточки поездки, не только факт
// успеха/неудачи.
@Injectable()
export class TripExtractionService {
  private readonly logger = new Logger(TripExtractionService.name);
  private client: Anthropic | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly files: FilesService,
  ) {}

  private getClient(): Anthropic {
    if (!this.client) {
      this.client = new Anthropic({ apiKey: this.config.getOrThrow<string>('ANTHROPIC_API_KEY') });
    }
    return this.client;
  }

  async extractOne(fileArtifactId: string): Promise<TripMaterialExtractionOutcome> {
    const { buffer, file } = await this.files.readBufferForProcessing(fileArtifactId);

    if (!isExtractableMimeType(file.mimeType)) {
      return { status: 'UNREADABLE', issue: `Формат файла (${file.mimeType}) не поддерживается автоматическим извлечением в этой версии`, fileName: file.name };
    }
    const block = buildMaterialContentBlock(buffer, file.mimeType, file.name);
    if (!block) {
      return { status: 'UNREADABLE', issue: `Не удалось подготовить файл «${file.name}» для анализа`, fileName: file.name };
    }

    try {
      const response = await this.getClient().messages.create({
        model: MODEL,
        max_tokens: 4096,
        system: buildExtractionSystemPrompt(),
        tools: [buildExtractionTool()],
        tool_choice: { type: 'tool', name: 'extract_trip_facts' },
        messages: [{ role: 'user', content: [block] }],
      });

      const toolBlock = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
      if (!toolBlock) throw new Error('no tool_use block in response');
      const draft = toolBlock.input as TripExtractionDraft;

      if (!draft.readable) {
        return { status: 'UNREADABLE', issue: draft.issues[0] ?? `Материал «${file.name}» не удалось разобрать`, fileName: file.name };
      }
      return { status: 'EXTRACTED', draft, fileName: file.name };
    } catch (err) {
      this.logger.warn(`trip extraction failed fileArtifactId=${fileArtifactId}: ${err instanceof Error ? err.message : 'unknown'}`);
      return { status: 'FAILED', issue: 'Ошибка при обращении к сервису анализа — материал будет обработан повторно', fileName: file.name };
    }
  }
}
