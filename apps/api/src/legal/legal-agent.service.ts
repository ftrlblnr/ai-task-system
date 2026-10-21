import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import { AiUsageService, errorText } from '../ai-usage/ai-usage.service';
import { localDateString } from '../common/timezone';
import {
  buildLegalSystemPrompt,
  buildLegalTools,
  citationProblemsReport,
  LEGAL_MODEL,
  parseSubmittedAnswer,
  verifyCitations,
  type LegalAnswer,
  type NpaDocumentBrief,
} from './legal-agent';
import { NpaSearchService } from './npa-search.service';

// Цикл tool use агента-юриста (handoff, раздел 3.2): модель сама ищет и
// читает статьи базы НПА, сдаёт итог инструментом submit_answer, сервер
// перепроверяет каждую цитату и даёт одну попытку исправления; что не
// исправлено — помечается «НЕ ПОДТВЕРЖДЕНО», а не выбрасывается молча.

// Раунды = обращения к модели. Вопрос по НПА: поиск → 2–4 статьи →
// проверка цитат → ответ, обычно 4–8 раундов; потолок — от зацикливания.
const ASK_MAX_ROUNDS = 12;
// Размышления Opus входят в max_tokens; запрос стримится (finalMessage),
// поэтому большой потолок не грозит таймаутом HTTP.
const MAX_TOKENS = 16000;
// Длинные статьи (кодексы — до ~50 тыс. символов) режем: цитата нужна из
// начала нормы почти всегда, а контекст не раздувается на каждом раунде.
const ARTICLE_TEXT_LIMIT = 30000;
const SEARCH_LIMIT = 8;
const DOCUMENTS_TTL_MS = 10 * 60 * 1000;

export type LegalAgentErrorCode = 'NO_ANSWER' | 'TOO_MANY_ROUNDS' | 'REFUSED' | 'OUTPUT_TOO_LONG' | 'EMPTY_BASE';

// Ожидаемые отказы агента — безопасный код наружу (чат, HTTP), подробности
// только в лог.
export class LegalAgentError extends Error {
  constructor(
    readonly code: LegalAgentErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'LegalAgentError';
  }
}

export interface LegalAskResult extends LegalAnswer {
  rounds: number;
  durationMs: number;
}

@Injectable()
export class LegalAgentService {
  private readonly logger = new Logger(LegalAgentService.name);
  private client: Anthropic | null = null;
  private documents: { at: number; list: NpaDocumentBrief[] } | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly npa: NpaSearchService,
    @Optional() private readonly aiUsage?: AiUsageService,
  ) {}

  private getClient(): Anthropic {
    if (!this.client) {
      this.client = new Anthropic({ apiKey: this.config.getOrThrow<string>('ANTHROPIC_API_KEY') });
    }
    return this.client;
  }

  // Список актов входит в system prompt — тот же текст от вызова к вызову,
  // поэтому кэшируется и в памяти, и в prompt cache Anthropic.
  private async listDocuments(): Promise<NpaDocumentBrief[]> {
    if (this.documents && Date.now() - this.documents.at < DOCUMENTS_TTL_MS) return this.documents.list;
    const list = await this.npa.listDocuments();
    if (list.length === 0) throw new LegalAgentError('EMPTY_BASE', 'База НПА пуста — выполните npm run legal:import');
    this.documents = { at: Date.now(), list };
    return list;
  }

  async ask(question: string): Promise<LegalAskResult> {
    const started = Date.now();
    const documents = await this.listDocuments();
    const system = buildLegalSystemPrompt(documents);
    const tools = buildLegalTools(documents);
    const messages: Anthropic.MessageParam[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: `Сегодня ${localDateString(new Date())}.` },
          { type: 'text', text: `Вопрос юриста:\n${question.trim()}` },
        ],
      },
    ];

    let fixRequested = false;
    let nudged = false;
    for (let round = 1; round <= ASK_MAX_ROUNDS; round++) {
      const message = await this.callModel('legal.ask', system, tools, messages, round);
      if (message.stop_reason === 'refusal') throw new LegalAgentError('REFUSED', 'Модель отказалась отвечать');
      if (message.stop_reason === 'max_tokens') throw new LegalAgentError('OUTPUT_TOO_LONG', 'Ответ не поместился в лимит токенов');
      // Ответ модели — как есть, вместе с блоками размышлений: Opus 5.5
      // привязывает их к беседе, правка истории ломает префикс.
      messages.push({ role: 'assistant', content: message.content });

      const toolUses = message.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
      if (toolUses.length === 0) {
        // tool_choice auto не гарантирует вызов: модель могла ответить
        // текстом. Одна просьба сдать ответ инструментом.
        if (nudged) throw new LegalAgentError('NO_ANSWER', 'Агент не сдал ответ через submit_answer');
        nudged = true;
        messages.push({ role: 'user', content: 'Сдай итог через инструмент submit_answer — текст вне него юрист не увидит.' });
        continue;
      }

      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const block of toolUses) {
        if (block.name !== 'submit_answer') {
          results.push(await this.runTool(block));
          continue;
        }
        const submitted = parseSubmittedAnswer(block.input);
        if (!submitted) {
          results.push({ type: 'tool_result', tool_use_id: block.id, is_error: true, content: 'Пустой вывод (conclusion) — заполни ответ.' });
          continue;
        }
        const citations = verifyCitations(submitted.citations, await this.npa.lookupArticles(submitted.citations.map((c) => c.norm_id)));
        const problems = citationProblemsReport(citations);
        if (problems && !fixRequested && round < ASK_MAX_ROUNDS) {
          fixRequested = true;
          results.push({ type: 'tool_result', tool_use_id: block.id, is_error: true, content: problems });
          continue;
        }
        const durationMs = Date.now() - started;
        this.logger.log(
          `legal.ask: раундов ${round}, норм ${citations.length}, не подтверждено ${citations.filter((c) => !c.verified).length}, ${Math.round(durationMs / 1000)} с`,
        );
        return {
          conclusion: submitted.conclusion,
          reasoning: submitted.reasoning,
          citations,
          notCovered: submitted.not_covered,
          questions: submitted.questions,
          model: LEGAL_MODEL,
          rounds: round,
          durationMs,
        };
      }

      const content: Anthropic.MessageParam['content'] = [...results];
      // Предпоследний раунд — предупреждаем, иначе потолок оборвёт работу
      // без ответа.
      if (round === ASK_MAX_ROUNDS - 1) {
        content.push({ type: 'text', text: 'Лимит обращений почти исчерпан: следующим шагом сдай submit_answer с тем, что уже проверено.' });
      }
      messages.push({ role: 'user', content });
    }
    throw new LegalAgentError('TOO_MANY_ROUNDS', `Агент не уложился в ${ASK_MAX_ROUNDS} раундов`);
  }

  private async callModel(
    feature: string,
    system: string,
    tools: Anthropic.Tool[],
    messages: Anthropic.MessageParam[],
    round: number,
  ): Promise<Anthropic.Message> {
    const started = Date.now();
    try {
      const message = await this.getClient()
        .messages.stream({
          model: LEGAL_MODEL,
          max_tokens: MAX_TOKENS,
          // Юридический вывод — где ошибка дороже времени: effort high
          // (handoff, раздел 3.2). Размышления на Opus 5.5 не отключаются.
          output_config: { effort: 'high' },
          // system + tools одинаковы для всех вопросов; верхнеуровневая метка
          // кэширует растущую историю между раундами.
          system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
          cache_control: { type: 'ephemeral' },
          tools,
          tool_choice: { type: 'auto' },
          messages,
        })
        .finalMessage();
      this.aiUsage?.record({ feature, model: LEGAL_MODEL, latencyMs: Date.now() - started, ok: true, usage: message.usage, meta: { round } });
      return message;
    } catch (err) {
      this.aiUsage?.record({ feature, model: LEGAL_MODEL, latencyMs: Date.now() - started, ok: false, error: errorText(err), meta: { round } });
      throw err;
    }
  }

  private async runTool(block: Anthropic.ToolUseBlock): Promise<Anthropic.ToolResultBlockParam> {
    const input = (block.input ?? {}) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === 'string' ? v : '');
    const result = (content: unknown, isError = false): Anthropic.ToolResultBlockParam => ({
      type: 'tool_result',
      tool_use_id: block.id,
      content: typeof content === 'string' ? content : JSON.stringify(content),
      is_error: isError,
    });
    try {
      if (block.name === 'search_npa') {
        const hits = await this.npa.find(str(input.query), { code: str(input.code) || undefined, limit: SEARCH_LIMIT });
        return result(hits.length ? hits : 'Ничего не найдено — переформулируй запрос или убери фильтр по акту.');
      }
      if (block.name === 'get_article') {
        const a = await this.npa.getArticle(str(input.id));
        if (!a) return result(`Статьи ${str(input.id)} нет в базе.`, true);
        const truncated = a.text.length > ARTICLE_TEXT_LIMIT;
        return result({
          ...a,
          text: truncated ? `${a.text.slice(0, ARTICLE_TEXT_LIMIT)}\n[…статья обрезана: показаны первые ${ARTICLE_TEXT_LIMIT} символов]` : a.text,
        });
      }
      if (block.name === 'verify_quote') {
        const v = await this.npa.verifyQuote(str(input.id), str(input.quote));
        return result(!v.exists ? `Статьи ${v.id} нет в базе.` : v.verified ? 'ЦИТАТА ПОДТВЕРЖДЕНА' : 'ЦИТАТА НЕ НАЙДЕНА в тексте статьи');
      }
      if (block.name === 'term') {
        const terms = await this.npa.term(str(input.query));
        return result(terms.length ? terms : 'Определение не найдено.');
      }
      return result(`Неизвестный инструмент ${block.name}.`, true);
    } catch (err) {
      this.logger.error(`legal tool ${block.name} failed: ${errorText(err)}`);
      return result('Инструмент временно недоступен.', true);
    }
  }
}
