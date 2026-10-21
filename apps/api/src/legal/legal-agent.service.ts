import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import { AiUsageService, errorText } from '../ai-usage/ai-usage.service';
import { localDateString } from '../common/timezone';
import {
  buildLegalSystemPrompt,
  buildLegalTools,
  citationProblemsReport,
  findingProblemsReport,
  LEGAL_MODEL,
  parseSubmittedAnswer,
  parseSubmittedReview,
  sortFindings,
  verifyCitations,
  verifyFindings,
  type LegalAnswer,
  type LegalMode,
  type LegalReview,
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
// Разбор договора: применимые акты, десятки статей, проверка цитат — до 25.
const REVIEW_MAX_ROUNDS = 25;
// Размышления Opus входят в max_tokens; запрос стримится (finalMessage),
// поэтому большой потолок не грозит таймаутом HTTP. Итог разбора — до ~25
// находок с цитатами, ему нужен запас.
const MAX_TOKENS: Record<LegalMode, number> = { ask: 16000, review: 48000 };
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

export interface LegalReviewResult extends LegalReview {
  rounds: number;
  durationMs: number;
}

// Итог одного submit_*: принят (done) или вернуть агенту на исправление.
type SubmitOutcome<T> = { done: T } | { retry: string };

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
    const result = await this.run<LegalAnswer>({
      mode: 'ask',
      feature: 'legal.ask',
      maxRounds: ASK_MAX_ROUNDS,
      submitTool: 'submit_answer',
      intro: [`Вопрос юриста:\n${question.trim()}`],
      onSubmit: async (input, canRetry) => {
        const submitted = parseSubmittedAnswer(input);
        if (!submitted) return { retry: 'Пустой вывод (conclusion) — заполни ответ.' };
        const citations = verifyCitations(submitted.citations, await this.npa.lookupArticles(submitted.citations.map((c) => c.norm_id)));
        const problems = citationProblemsReport(citations);
        if (problems && canRetry) return { retry: problems };
        return {
          done: {
            conclusion: submitted.conclusion,
            reasoning: submitted.reasoning,
            citations,
            notCovered: submitted.not_covered,
            questions: submitted.questions,
            model: LEGAL_MODEL,
          },
        };
      },
    });
    const durationMs = Date.now() - started;
    const unverified = result.value.citations.filter((c) => !c.verified).length;
    this.logger.log(`legal.ask: раундов ${result.rounds}, норм ${result.value.citations.length}, не подтверждено ${unverified}, ${Math.round(durationMs / 1000)} с`);
    return { ...result.value, rounds: result.rounds, durationMs };
  }

  // Разбор договора: текст уже извлечён (contract-text.ts), лежит в первом
  // сообщении целиком; focus — «на что обратить внимание» от юриста.
  async review(contractText: string, fileName: string, focus?: string | null): Promise<LegalReviewResult> {
    const started = Date.now();
    const intro = [`Договор: файл «${fileName}».`];
    if (focus?.trim()) intro.push(`Юрист просит обратить особое внимание: ${focus.trim()}`);
    intro.push(`<contract>\n${contractText}\n</contract>`);
    const result = await this.run<LegalReview>({
      mode: 'review',
      feature: 'legal.review',
      maxRounds: REVIEW_MAX_ROUNDS,
      submitTool: 'submit_review',
      intro,
      onSubmit: async (input, canRetry) => {
        const submitted = parseSubmittedReview(input);
        if (!submitted) return { retry: 'Разбор пуст: нужны summary и массив findings.' };
        const ids = submitted.findings.map((f) => f.norm_id).filter(Boolean);
        const findings = verifyFindings(submitted.findings, await this.npa.lookupArticles(ids), contractText);
        const problems = findingProblemsReport(findings);
        if (problems && canRetry) return { retry: problems };
        return {
          done: {
            contract: submitted.contract || fileName,
            gcRole: submitted.gc_role,
            applicableActs: submitted.applicable_acts,
            summary: submitted.summary,
            findings: sortFindings(findings),
            generalIssues: submitted.general_issues,
            notChecked: submitted.not_checked,
            model: LEGAL_MODEL,
          },
        };
      },
    });
    const durationMs = Date.now() - started;
    const unverified = result.value.findings.filter((f) => !f.verified).length;
    this.logger.log(`legal.review: раундов ${result.rounds}, находок ${result.value.findings.length}, не подтверждено ${unverified}, ${Math.round(durationMs / 1000)} с`);
    return { ...result.value, rounds: result.rounds, durationMs };
  }

  // Общий цикл: модель ищет/читает/проверяет, итог сдаёт submitTool;
  // onSubmit проверяет его на сервере и один раз может вернуть на доработку.
  private async run<T>(opts: {
    mode: LegalMode;
    feature: string;
    maxRounds: number;
    submitTool: string;
    intro: string[];
    onSubmit: (input: unknown, canRetry: boolean) => Promise<SubmitOutcome<T>>;
  }): Promise<{ value: T; rounds: number }> {
    const documents = await this.listDocuments();
    const system = buildLegalSystemPrompt(documents, opts.mode);
    const tools = buildLegalTools(documents, opts.mode);
    const messages: Anthropic.MessageParam[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: `Сегодня ${localDateString(new Date())}.` },
          ...opts.intro.map((text) => ({ type: 'text' as const, text })),
        ],
      },
    ];

    let fixRequested = false;
    let nudged = false;
    for (let round = 1; round <= opts.maxRounds; round++) {
      const message = await this.callModel(opts.feature, opts.mode, system, tools, messages, round);
      if (message.stop_reason === 'refusal') throw new LegalAgentError('REFUSED', 'Модель отказалась отвечать');
      if (message.stop_reason === 'max_tokens') throw new LegalAgentError('OUTPUT_TOO_LONG', 'Ответ не поместился в лимит токенов');
      // Ответ модели — как есть, вместе с блоками размышлений: Opus 5.5
      // привязывает их к беседе, правка истории ломает префикс.
      messages.push({ role: 'assistant', content: message.content });

      const toolUses = message.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
      if (toolUses.length === 0) {
        // tool_choice auto не гарантирует вызов: модель могла ответить
        // текстом. Одна просьба сдать итог инструментом.
        if (nudged) throw new LegalAgentError('NO_ANSWER', `Агент не сдал итог через ${opts.submitTool}`);
        nudged = true;
        messages.push({ role: 'user', content: `Сдай итог через инструмент ${opts.submitTool} — текст вне него юрист не увидит.` });
        continue;
      }

      // Поиск и чтение статей одного хода — параллельно (промпт об этом
      // просит); порядок tool_result — как у tool_use.
      const results = await Promise.all(
        toolUses.map(async (block): Promise<Anthropic.ToolResultBlockParam | { done: T }> => {
          if (block.name !== opts.submitTool) return this.runTool(block);
          const outcome = await opts.onSubmit(block.input, !fixRequested && round < opts.maxRounds);
          if ('done' in outcome) return outcome;
          return { type: 'tool_result', tool_use_id: block.id, is_error: true, content: outcome.retry };
        }),
      );
      const done = results.find((r): r is { done: T } => 'done' in r);
      if (done) return { value: done.done, rounds: round };
      if (toolUses.some((b) => b.name === opts.submitTool)) fixRequested = true;

      const content: Anthropic.MessageParam['content'] = results as Anthropic.ToolResultBlockParam[];
      // Предпоследний раунд — предупреждаем, иначе потолок оборвёт работу
      // без итога.
      if (round === opts.maxRounds - 1) {
        content.push({ type: 'text', text: `Лимит обращений почти исчерпан: следующим шагом сдай ${opts.submitTool} с тем, что уже проверено.` });
      }
      messages.push({ role: 'user', content });
    }
    throw new LegalAgentError('TOO_MANY_ROUNDS', `Агент не уложился в ${opts.maxRounds} раундов`);
  }

  private async callModel(
    feature: string,
    mode: LegalMode,
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
          max_tokens: MAX_TOKENS[mode],
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
