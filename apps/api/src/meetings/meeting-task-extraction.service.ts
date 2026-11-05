import { Injectable, InternalServerErrorException, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import type { ConfidenceLevel, TaskPriority } from '@prisma/client';
import { AiUsageService, trackedCreate } from '../ai-usage/ai-usage.service';
import { EmployeeResolverService } from '../employees/employee-resolver.service';
import { localDateString, withLocalOffset } from '../common/timezone';
import { sameTask } from './meeting-proposal-similarity';

export interface EmployeeOption {
  id: string;
  fullName: string;
}

export interface TranscriptLine {
  segmentId: string;
  startMs: number;
  // Имя говорящего, если сопоставлено, иначе метка («Speaker 2»).
  speaker: string;
  text: string;
}

export interface MeetingExtractionInput {
  meetingTitle: string;
  meetingDate: Date;
  summary: string;
  transcript: TranscriptLine[];
  // Кто записал встречу — его собственные обещания тоже поручения.
  ownerName: string | null;
  employees: EmployeeOption[];
}

// Поручение после проверки сервером: исполнитель найден резолвером, срок —
// дата со смещением, ссылка на реплику — только на реплику этой встречи.
export interface ExtractedProposal {
  title: string;
  description: string | null;
  assigneeId: string | null;
  assigneeRawText: string | null;
  dueDate: Date | null;
  priority: TaskPriority | null;
  confidence: ConfidenceLevel;
  sourceContext: string;
  segmentId: string | null;
  sourceTimestamp: string | null;
}

interface RawProposal {
  title: string;
  description: string | null;
  assigneeRawText: string | null;
  dueDate: string | null;
  priority: TaskPriority | null;
  confidence: ConfidenceLevel;
  sourceContext: string;
  ref: string | null;
}

// Длинная расшифровка — окнами (AGENT_AND_MEETINGS.md, B.4): двухчасовое
// совещание не помещается в один запрос с запасом на ответ. Перекрытие —
// чтобы поручение на стыке окон целиком попало хотя бы в одно.
export const WINDOW_CHARS = 40_000;
export const WINDOW_OVERLAP_CHARS = 2_000;

// Только день без времени — конец рабочего дня.
const DATE_ONLY_TIME = '18:00:00';

const NULLABLE_STRING = { anyOf: [{ type: 'string' }, { type: 'null' }] } as const;

export function mmss(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

// Модель ссылается на реплику коротким номером [S12], а не cuid: короче в
// токенах и не исказится при копировании; номер переводится в segmentId
// сервером.
function refOf(index: number): string {
  return `S${index + 1}`;
}

export function formatTranscriptLine(line: TranscriptLine, index: number): string {
  return `[${refOf(index)}] ${mmss(line.startMs)} ${line.speaker}: ${line.text}`;
}

// Окна по целым строкам: строка не разрезается посередине, каждое
// следующее окно начинается с последних ~2 тыс. символов предыдущего.
export function splitTranscript(lines: string[], windowChars = WINDOW_CHARS, overlapChars = WINDOW_OVERLAP_CHARS): string[] {
  if (lines.length === 0) return [];
  const windows: string[] = [];
  let start = 0;
  while (start < lines.length) {
    let end = start;
    let size = 0;
    while (end < lines.length && (end === start || size + lines[end].length + 1 <= windowChars)) {
      size += lines[end].length + 1;
      end++;
    }
    windows.push(lines.slice(start, end).join('\n'));
    if (end >= lines.length) break;
    // Откат назад на перекрытие, но всегда хотя бы на строку вперёд.
    let next = end;
    let back = 0;
    while (next - 1 > start && back + lines[next - 1].length + 1 <= overlapChars) {
      back += lines[next - 1].length + 1;
      next--;
    }
    start = next;
  }
  return windows;
}

// Срок от модели — местное время без смещения (как у календарных
// инструментов ассистента): «2026-11-04» или «2026-11-04T15:00».
export function parseLocalDue(value: string | null): Date | null {
  if (!value) return null;
  const trimmed = value.trim();
  const withTime = /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? `${trimmed}T${DATE_ONLY_TIME}` : trimmed;
  const date = new Date(withLocalOffset(withTime) ?? '');
  return Number.isNaN(date.getTime()) ? null : date;
}

// Окна перекрываются, и одно поручение может прийти дважды — оставляем
// первое (у него обычно полнее контекст), второе отбрасываем.
export function mergeProposals(lists: RawProposal[][]): RawProposal[] {
  const merged: RawProposal[] = [];
  for (const list of lists) {
    for (const p of list) {
      if (!merged.some((m) => sameTask(m.title, m.assigneeRawText, p.title, p.assigneeRawText))) merged.push(p);
    }
  }
  return merged;
}

// Ответ — JSON по схеме (output_config.format), а не принудительный вызов
// инструмента: tool_choice tool/any на Opus 5.5 даёт 400, и разбор встреч
// падал целиком (прод 05.11.2026).
function buildExtractionSchema(): Record<string, unknown> {
  return {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              description: NULLABLE_STRING,
              // Как исполнитель назван в записи — сотрудника по имени находит
              // сервер (EmployeeResolverService), неоднозначное имя остаётся
              // подсказкой руководителю.
              assigneeRawText: NULLABLE_STRING,
              dueDate: NULLABLE_STRING,
              priority: { anyOf: [{ type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] }, { type: 'null' }] },
              confidence: { type: 'string', enum: ['HIGH', 'MEDIUM', 'LOW'] },
              sourceContext: { type: 'string' },
              ref: NULLABLE_STRING,
            },
            required: ['title', 'description', 'assigneeRawText', 'dueDate', 'priority', 'confidence', 'sourceContext', 'ref'],
            additionalProperties: false,
          },
        },
      },
      required: ['tasks'],
      additionalProperties: false,
  };
}

function buildSystemPrompt(input: MeetingExtractionInput, hasTranscript: boolean, windowNote: string): string {
  // По местному времени: встреча в 01:00 по Алматы — ещё вчера по UTC.
  const meetingDate = localDateString(input.meetingDate);
  const employees = input.employees.length > 0 ? input.employees.map((e) => `- ${e.fullName}`).join('\n') : '(список пуст)';
  const owner = input.ownerName
    ? `Встречу записал руководитель — ${input.ownerName}. Его собственные обещания («я согласую», «посмотрю договор») — тоже поручения, исполнитель — ${input.ownerName}.`
    : '';
  const source = hasTranscript
    ? 'Ниже — саммари встречи и расшифровка: строки «[S12] мм:сс Говорящий: текст». Поручения ищи прежде всего в расшифровке, саммари — для общего контекста.'
    : 'Расшифровки нет — только саммари. ref всегда null.';

  return `Ты помогаешь руководителю превратить запись встречи в список поручений. Ответ — JSON-объект { "tasks": [...] } по заданной схеме.

Встреча: «${input.meetingTitle}», дата: ${meetingDate}. ${owner}
${source}${windowNote}

ЧТО СЧИТАТЬ ПОРУЧЕНИЕМ: явное, однозначное поручение или договорённость сделать что-то конкретное («Жандос подготовит смету к среде», «нужно связаться с поставщиком»). НЕ поручение: общая тема обсуждения, констатация факта, мнение, вопрос без принятого решения. Сомневаешься — не включай: лучше пропустить, чем придумать.

title — коротко, с глагола («Подготовить смету по объекту»). description — подробности, если они прозвучали, иначе null.

assigneeRawText — имя исполнителя, как его можно узнать: полное имя из списка сотрудников ниже, если понятно, о ком речь; иначе как прозвучало («Самат из подрядчика»). Не назван — null.
Сотрудники:
${employees}

dueDate — местное время без смещения: «ГГГГ-ММ-ДД» (только день) или «ГГГГ-ММ-ДДTчч:мм». Относительные сроки («к пятнице», «на следующей неделе») — от ДАТЫ ВСТРЕЧИ ${meetingDate}, не от сегодня. Срок не прозвучал — null.

confidence — уверенность в деталях (кто и когда), не в самом факте поручения: HIGH — исполнитель и срок явно названы; MEDIUM — поручение явное, исполнитель или срок предположительны; LOW — угадывается по смыслу.

sourceContext — 1–2 предложения, откуда поручение: его увидит исполнитель, у которого нет доступа к встрече, поэтому без лишних подробностей обсуждения.

ref — номер реплики, где прозвучало поручение («S12»), иначе null.

Поручений нет — верни tasks: [].`;
}

// Opus, effort low: разовое действие по кнопке на всю запись — качество
// важнее скорости (тот же выбор, что раньше).
const MODEL = 'claude-opus-5-5';

@Injectable()
export class MeetingTaskExtractionService {
  private client: Anthropic | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly resolver: EmployeeResolverService,
    @Optional() private readonly aiUsage?: AiUsageService,
  ) {}

  private getClient(): Anthropic {
    if (!this.client) {
      this.client = new Anthropic({ apiKey: this.config.getOrThrow<string>('ANTHROPIC_API_KEY') });
    }
    return this.client;
  }

  private async extractWindow(system: string, content: string): Promise<RawProposal[]> {
    const response = await trackedCreate(this.aiUsage, 'meetings.task-extraction', this.getClient(), {
      model: MODEL,
      // 4096 не хватало: на совещании с ~50 поручениями ответ обрывался и
      // задачи не извлекались вовсе (прод 21.10.2026).
      max_tokens: 16000,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: buildExtractionSchema() } },
      system,
      messages: [{ role: 'user', content }],
    });

    if (response.stop_reason === 'max_tokens') {
      throw new InternalServerErrorException('Встреча слишком длинная: список задач не поместился в ответ модели');
    }
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    let tasks: unknown;
    try {
      tasks = (JSON.parse(text) as { tasks?: unknown }).tasks;
    } catch {
      tasks = undefined;
    }
    if (!Array.isArray(tasks)) {
      throw new InternalServerErrorException('Claude не вернул структурированный список задач');
    }
    return tasks as RawProposal[];
  }

  async extract(input: MeetingExtractionInput): Promise<ExtractedProposal[]> {
    const lines = input.transcript.map(formatTranscriptLine);
    const windows = splitTranscript(lines);
    const summaryBlock = `# Саммари\n${input.summary.trim() || '(нет)'}`;

    const results: RawProposal[][] = [];
    if (windows.length === 0) {
      results.push(await this.extractWindow(buildSystemPrompt(input, false, ''), summaryBlock));
    } else {
      // По очереди, не параллельно: окна — это одна встреча, и Opus за раз
      // хватает (лимиты API и память контейнера).
      for (let i = 0; i < windows.length; i++) {
        const note = windows.length > 1 ? `\nРасшифровка длинная, это часть ${i + 1} из ${windows.length} — извлекай поручения только из этой части.` : '';
        results.push(await this.extractWindow(buildSystemPrompt(input, true, note), `${summaryBlock}\n\n# Расшифровка\n${windows[i]}`));
      }
    }

    const proposals: ExtractedProposal[] = [];
    for (const p of mergeProposals(results)) {
      proposals.push(await this.verify(p, input));
    }
    return proposals;
  }

  // Модели доверяем только текст: исполнителя ищет резолвер среди реальных
  // сотрудников, ссылка — только на реплику этой встречи, срок — с нашим
  // смещением.
  private async verify(p: RawProposal, input: MeetingExtractionInput): Promise<ExtractedProposal> {
    const raw = p.assigneeRawText?.trim() || null;
    const resolution = raw && input.employees.length > 0 ? await this.resolver.resolve(raw, input.employees) : null;
    const match = p.ref ? /^S(\d+)$/i.exec(p.ref.trim()) : null;
    const line = match ? input.transcript[Number(match[1]) - 1] : undefined;
    return {
      title: p.title.trim(),
      description: p.description?.trim() || null,
      assigneeId: resolution?.status === 'RESOLVED' ? resolution.employeeId : null,
      assigneeRawText: raw,
      dueDate: parseLocalDue(p.dueDate),
      priority: p.priority,
      confidence: p.confidence,
      sourceContext: p.sourceContext.trim(),
      segmentId: line?.segmentId ?? null,
      sourceTimestamp: line ? mmss(line.startMs) : null,
    };
  }
}
