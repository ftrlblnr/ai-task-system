import { Injectable, Logger } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { EventStatus, Role } from '@prisma/client';
import { TasksService } from '../tasks/tasks.service';
import { EventsService } from '../calendar/events.service';
import { FilesService } from '../files/files.service';
import { MeetingsService } from '../meetings/meetings.service';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import type { TaskCardData, EventCardData, FilePartData } from './dto/message-part-data.dto';
import { buildTasksWorkbookBuffer } from './task-export';

// Тот же MIME, что уже в ALLOWED_UPLOAD_MIME_TYPES (upload-file.dto.ts) для
// пользовательских .xlsx-вложений — единственный формат, который эта фаза
// генерирует.
const XLSX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// Столько карточек максимум в одном ответе — то же соображение, что
// MAX_CONTEXT_TASKS/MAX_CONTEXT_EVENTS в voice.service.ts: не заваливать
// ответ 40 карточками. totalCount ниже — реальное число до среза, чтобы
// модель могла честно сказать "всего 37, вот первые 10", а не соврать про
// количество.
const MAX_TOOL_ITEMS = 10;

export type GetTasksFilter = 'all' | 'overdue';

// Вынесены из getTasks/getEvents ниже (Stage 2, Phase H) — voice.service.ts
// строит те же карточки для только что созданной/изменённой голосом задачи/
// встречи, одна форма карточки для "просмотрел" и "только что сделал
// голосом". Принимают минимальный набор полей, а не целый Task/Event —
// TasksService.findAll/findOne/create/update возвращают разные select'ы
// (TASK_LIST_SELECT/TASK_DETAIL_SELECT), но оба — надмножество этих полей.
export function toTaskCardData(t: {
  id: string;
  title: string;
  status: string;
  dueDate: Date | null;
  assignee: { id: string; fullName: string } | null;
}): TaskCardData {
  return {
    taskId: t.id,
    title: t.title,
    status: t.status,
    dueDate: t.dueDate ? t.dueDate.toISOString() : null,
    assignee: t.assignee ? { id: t.assignee.id, name: t.assignee.fullName } : null,
  };
}

export function toEventCardData(e: {
  id: string;
  title: string;
  startAt: Date;
  endAt: Date;
  location: string | null;
  participants: { id: string; fullName: string }[];
}): EventCardData {
  return {
    eventId: e.id,
    title: e.title,
    startAt: e.startAt.toISOString(),
    endAt: e.endAt.toISOString(),
    location: e.location,
    participants: e.participants.map((p) => ({ id: p.id, name: p.fullName })),
  };
}

type KnownToolName =
  | 'get_tasks'
  | 'get_events'
  | 'export_tasks_xlsx'
  | 'get_recent_meetings'
  | 'search_meetings'
  | 'get_meeting'
  | 'search_meeting_transcript';

function resolveToolName(name: string): KnownToolName {
  if (name === 'get_events') return 'get_events';
  if (name === 'export_tasks_xlsx') return 'export_tasks_xlsx';
  if (name === 'get_recent_meetings') return 'get_recent_meetings';
  if (name === 'search_meetings') return 'search_meetings';
  if (name === 'get_meeting') return 'get_meeting';
  if (name === 'search_meeting_transcript') return 'search_meeting_transcript';
  return 'get_tasks';
}

// Безопасные коды для tool_result (аудит 16.09.2026, Phase F.1, P2.1) —
// расширено третьим инструментом в Phase G, тем же приёмом расширено
// четырьмя инструментами встреч/Plaud в Phase K.
const TOOL_ERROR_MESSAGES: Record<KnownToolName, string> = {
  get_tasks: 'TASK_LOOKUP_FAILED: не удалось получить список задач',
  get_events: 'CALENDAR_LOOKUP_FAILED: не удалось получить события календаря',
  export_tasks_xlsx: 'EXPORT_FAILED: не удалось сформировать файл',
  get_recent_meetings: 'MEETING_LOOKUP_FAILED: не удалось получить список встреч',
  search_meetings: 'MEETING_LOOKUP_FAILED: не удалось найти встречи',
  get_meeting: 'MEETING_LOOKUP_FAILED: не удалось получить встречу',
  search_meeting_transcript: 'MEETING_LOOKUP_FAILED: не удалось найти в транскриптах',
};

// Stage 2, Phase K (внешний аудит 21.09.2026, "Assistant meeting/Plaud
// tools") — до этой фазы Assistant вообще не мог отвечать на вопросы про
// прошлые встречи ("что обсуждали на встрече по заводу", "что Жандос
// сказал про договор") — только про задачи/календарь. Ответы строятся по
// Meeting/MeetingSegment в Postgres (уже синхронизированным Plaud-краном,
// см. plaud-sync.service.ts), не по runtime-запросу к Plaud API — тот же
// принцип "источник правды — наша БД", что и у остальных инструментов.
export interface MeetingSummaryData {
  meetingId: string;
  title: string;
  meetingDate: string;
}
export interface MeetingDetailData {
  meetingId: string;
  title: string;
  meetingDate: string;
  summary: string;
}
export interface MeetingTranscriptMatchData {
  meetingId: string;
  meetingTitle: string;
  speakerLabel: string;
  // Stage 2, Phase M (внешний аудит 21.09.2026, "speaker mapping пока не
  // полностью доступен Assistant") — раньше инструмент отдавал только
  // сырую метку ("Speaker 2"), хотя MeetingSegment.speakerEmployeeId уже
  // мог быть резолвлен (MeetingsService.updateSpeakers) — Assistant не мог
  // ответить "Жандос сказал...", только "Speaker 2 сказал...". null, если
  // говорящий ещё не сопоставлен с сотрудником — тогда используется
  // speakerLabel как раньше (см. промпт инструмента).
  speakerEmployeeId: string | null;
  speakerName: string | null;
  startMs: number;
  endMs: number;
  text: string;
}

export type ToolExecutionResult =
  | { tool: 'get_tasks'; items: TaskCardData[]; totalCount: number }
  | { tool: 'get_events'; items: EventCardData[]; totalCount: number }
  | { tool: 'export_tasks_xlsx'; file: FilePartData; totalCount: number }
  | { tool: 'get_recent_meetings'; items: MeetingSummaryData[]; totalCount: number }
  | { tool: 'search_meetings'; items: MeetingSummaryData[]; totalCount: number }
  | { tool: 'get_meeting'; meeting: MeetingDetailData }
  | { tool: 'search_meeting_transcript'; items: MeetingTranscriptMatchData[]; totalCount: number }
  | { tool: KnownToolName; error: true; message: string };

// Инструменты, которые Assistant Core (assistant-reply.service.ts) может
// предложить модели — только чтение, ничего не мутирует (спека Stage 2
// §16/§33: этот этап не про изменение задач/событий голосом-текстом, это
// уже делает voice-модуль своим отдельным путём). RBAC — на уровне того,
// какие инструменты вообще ВИДИТ модель (buildTools), а не постфактум:
// get_events просто отсутствует в списке для не-OWNER, тот же принцип,
// что уже в VoiceService.parse для видимости календаря.
@Injectable()
export class AssistantToolsService {
  private readonly logger = new Logger(AssistantToolsService.name);

  constructor(
    private readonly tasks: TasksService,
    private readonly events: EventsService,
    private readonly files: FilesService,
    private readonly meetings: MeetingsService,
    private readonly prisma: PrismaService,
  ) {}

  buildTools(user: AuthenticatedUser): Anthropic.Tool[] {
    const tools: Anthropic.Tool[] = [
      {
        name: 'get_tasks',
        description:
          'Получить список задач, видимых текущему пользователю (свои для сотрудника, все для руководителя), с исполнителем, сроком и статусом.',
        input_schema: {
          type: 'object',
          properties: {
            filter: {
              type: 'string',
              enum: ['all', 'overdue'],
              description: '"all" — все видимые задачи, "overdue" — только просроченные',
            },
          },
          required: ['filter'],
        },
      },
      {
        name: 'export_tasks_xlsx',
        description:
          'Сформировать файл Excel (.xlsx) со списком задач, видимых пользователю, и приложить его к ответу как файл для скачивания. Используй, когда пользователь просит выгрузить/экспортировать задачи файлом/таблицей/экселем, а не просто посмотреть их в чате.',
        input_schema: {
          type: 'object',
          properties: {
            filter: {
              type: 'string',
              enum: ['all', 'overdue'],
              description: '"all" — все видимые задачи, "overdue" — только просроченные',
            },
          },
          required: ['filter'],
        },
      },
    ];

    // Календарь — личный календарь руководителя, весь CalendarController
    // закрыт на Role.OWNER (раздел 5 ТЗ) — сотруднику этот инструмент не
    // предлагается вообще, а не отклоняется после вызова.
    if (user.role === Role.OWNER) {
      tools.push({
        name: 'get_events',
        description: 'Получить список предстоящих подтверждённых встреч в личном календаре руководителя.',
        input_schema: { type: 'object', properties: {} },
      });

      // Stage 2, Phase K (внешний аудит 21.09.2026) — те же протоколы
      // встреч, что и в /meetings (весь модуль закрыт на OWNER, раздел 15
      // ТЗ) — не отдельная копия видимости, тот же MeetingsService.
      tools.push({
        name: 'get_recent_meetings',
        description: 'Получить список последних встреч (протоколов), от новых к старым.',
        input_schema: {
          type: 'object',
          properties: { limit: { type: 'integer', description: 'Сколько встреч вернуть (по умолчанию 5)' } },
          required: [],
        },
      });
      tools.push({
        name: 'search_meetings',
        description:
          'Найти встречи по названию или содержанию саммари (поиск по подстроке, без учёта регистра). Используй, когда пользователь спрашивает про встречу по теме, а не просит просто список последних.',
        input_schema: {
          type: 'object',
          properties: { query: { type: 'string', description: 'Что искать — тема, название, ключевые слова' } },
          required: ['query'],
        },
      });
      tools.push({
        name: 'get_meeting',
        description: 'Получить полное саммари одной конкретной встречи по её id (обычно из get_recent_meetings/search_meetings).',
        input_schema: {
          type: 'object',
          properties: { meetingId: { type: 'string' } },
          required: ['meetingId'],
        },
      });
      tools.push({
        name: 'search_meeting_transcript',
        description:
          'Найти конкретные реплики в транскриптах встреч по ключевым словам — кто и что именно сказал, не общий пересказ саммари. Может не найти ничего, если транскрипт этой встречи ещё не синхронизирован (это отдельная, не всегда доступная часть данных) — в этом случае честно скажи, что не нашёл, не выдумывай. meetingId необязателен, ограничивает поиск одной встречей. У каждой реплики есть speakerLabel (техническая метка вида "Speaker 2") и, если руководитель уже сопоставил говорящего с сотрудником, speakerName — используй speakerName в ответе, если он есть, иначе speakerLabel.',
        input_schema: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            meetingId: { type: 'string' },
          },
          required: ['query'],
        },
      });
    }

    return tools;
  }

  async execute(name: string, input: unknown, user: AuthenticatedUser): Promise<ToolExecutionResult> {
    try {
      if (name === 'get_tasks') {
        const filter = (input as { filter?: unknown } | null)?.filter;
        return await this.getTasks(user, filter === 'overdue' ? 'overdue' : 'all');
      }
      if (name === 'get_events') return await this.getEvents(user);
      if (name === 'export_tasks_xlsx') {
        const filter = (input as { filter?: unknown } | null)?.filter;
        return await this.exportTasksXlsx(user, filter === 'overdue' ? 'overdue' : 'all');
      }
      if (name === 'get_recent_meetings') {
        const rawLimit = Number((input as { limit?: unknown } | null)?.limit);
        return await this.getRecentMeetings(Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 5);
      }
      if (name === 'search_meetings') {
        const query = (input as { query?: unknown } | null)?.query;
        return await this.searchMeetings(typeof query === 'string' ? query : '');
      }
      if (name === 'get_meeting') {
        const meetingId = (input as { meetingId?: unknown } | null)?.meetingId;
        return await this.getMeeting(typeof meetingId === 'string' ? meetingId : '', user);
      }
      if (name === 'search_meeting_transcript') {
        const typedInput = input as { query?: unknown; meetingId?: unknown } | null;
        const query = typeof typedInput?.query === 'string' ? typedInput.query : '';
        const meetingId = typeof typedInput?.meetingId === 'string' ? typedInput.meetingId : undefined;
        return await this.searchMeetingTranscript(query, meetingId);
      }
      return { tool: 'get_tasks', error: true, message: `Неизвестный инструмент: ${name}` };
    } catch (err) {
      const tool = resolveToolName(name);
      // Полная ошибка (может содержать детали БД/инфраструктуры) — только в
      // серверный лог. Модели (и через неё — пользователю) уходит только
      // безопасный код + короткая фраза, без err.message (аудит 16.09.2026,
      // находка про утечку сырых ошибок в tool_result).
      const err2 = err instanceof Error ? err : new Error(String(err));
      this.logger.error(`tool=${name} failed: ${err2.message}`, err2.stack);
      return { tool, error: true, message: TOOL_ERROR_MESSAGES[tool] };
    }
  }

  private async getTasks(user: AuthenticatedUser, filter: GetTasksFilter = 'all'): Promise<ToolExecutionResult> {
    const tasks = await this.tasks.findAll(user);
    const filtered = filter === 'overdue' ? tasks.filter((t) => t.isOverdue) : tasks;
    // findAll() вызывается напрямую (в обход HTTP-сериализации), поэтому
    // dueDate — сырой Prisma Date, не строка (тот же приём, что уже был
    // пойман в voice.service.ts при прямом вызове TasksService.findOne) —
    // toTaskCardData учитывает это сам.
    const items: TaskCardData[] = filtered.slice(0, MAX_TOOL_ITEMS).map(toTaskCardData);
    return { tool: 'get_tasks', items, totalCount: filtered.length };
  }

  // Stage 2, Phase G — в отличие от getTasks выше, здесь НЕТ среза на
  // MAX_TOOL_ITEMS: карточки в чате намеренно ограничены (не заваливать
  // ответ), но весь смысл экспорта в файл — увидеть больше, чем 10 задач,
  // иначе экспорт был бы бесполезен ровно в том случае, ради которого его
  // и попросили.
  private async exportTasksXlsx(user: AuthenticatedUser, filter: GetTasksFilter = 'all'): Promise<ToolExecutionResult> {
    const tasks = await this.tasks.findAll(user);
    const filtered = filter === 'overdue' ? tasks.filter((t) => t.isOverdue) : tasks;
    const buffer = await buildTasksWorkbookBuffer(filtered);
    const label = filter === 'overdue' ? 'просроченные' : 'все';
    const name = `Задачи (${label}) ${new Date().toISOString().slice(0, 10)}.xlsx`;
    const artifact = await this.files.createGenerated(user, buffer, name, XLSX_MIME_TYPE);
    return {
      tool: 'export_tasks_xlsx',
      totalCount: filtered.length,
      file: { fileId: artifact.id, name: artifact.name, mimeType: artifact.mimeType, size: artifact.size },
    };
  }

  private async getEvents(user: AuthenticatedUser): Promise<ToolExecutionResult> {
    const now = new Date();
    const events = await this.events.findAll(user.id);
    const upcoming = events.filter((e) => e.status !== EventStatus.CANCELLED && e.startAt >= now);
    const items: EventCardData[] = upcoming.slice(0, MAX_TOOL_ITEMS).map(toEventCardData);
    return { tool: 'get_events', items, totalCount: upcoming.length };
  }

  // MeetingsService.findAll() уже сортирует по meetingDate desc — "recent"
  // значит просто первые limit элементов, без отдельной сортировки здесь.
  private async getRecentMeetings(limit: number): Promise<ToolExecutionResult> {
    const meetings = await this.meetings.findAll();
    const capped = Math.min(limit, MAX_TOOL_ITEMS);
    const items: MeetingSummaryData[] = meetings.slice(0, capped).map((m) => ({
      meetingId: m.id,
      title: m.title,
      meetingDate: m.meetingDate.toISOString(),
    }));
    return { tool: 'get_recent_meetings', items, totalCount: meetings.length };
  }

  // Поиск по подстроке (ILIKE через Prisma mode: 'insensitive'), не
  // полнотекстовый поиск — простой и достаточный для объёма встреч одной
  // компании, не требует отдельной tsvector-инфраструктуры.
  private async searchMeetings(query: string): Promise<ToolExecutionResult> {
    const trimmed = query.trim();
    if (!trimmed) return { tool: 'search_meetings', items: [], totalCount: 0 };

    const where = {
      OR: [
        { title: { contains: trimmed, mode: 'insensitive' as const } },
        { rawSummary: { contains: trimmed, mode: 'insensitive' as const } },
        { enhancedSummary: { contains: trimmed, mode: 'insensitive' as const } },
      ],
    };
    const [meetings, totalCount] = await Promise.all([
      this.prisma.meeting.findMany({ where, select: { id: true, title: true, meetingDate: true }, orderBy: { meetingDate: 'desc' }, take: MAX_TOOL_ITEMS }),
      this.prisma.meeting.count({ where }),
    ]);
    const items: MeetingSummaryData[] = meetings.map((m) => ({ meetingId: m.id, title: m.title, meetingDate: m.meetingDate.toISOString() }));
    return { tool: 'search_meetings', items, totalCount };
  }

  // Делегирует MeetingsService.findOne — тот же 404 (NotFoundException,
  // ловится общим try/catch в execute()) и тот же обязательный audit.log
  // READ (раздел 15 ТЗ: аудит обращений к протоколам встреч), не
  // задваиваем его здесь отдельным запросом.
  private async getMeeting(meetingId: string, user: AuthenticatedUser): Promise<ToolExecutionResult> {
    const meeting = await this.meetings.findOne(meetingId, user.id);
    return {
      tool: 'get_meeting',
      meeting: {
        meetingId: meeting.id,
        title: meeting.title,
        meetingDate: meeting.meetingDate.toISOString(),
        summary: meeting.enhancedSummary ?? meeting.rawSummary,
      },
    };
  }

  // Stage 2, Phase K — best-effort: MeetingSegment заполняется только для
  // встреч, где формат транскрипта Plaud удалось распарсить (см.
  // предупреждение в plaud-sync.service.ts/transcript-parser.ts) — пустой
  // результат здесь означает либо "ничего не сказали по теме", либо
  // "транскрипт этой встречи ещё не синхронизирован", промпт инструмента
  // прямо просит модель не путать одно с другим и не выдумывать ответ.
  private async searchMeetingTranscript(query: string, meetingId?: string): Promise<ToolExecutionResult> {
    const trimmed = query.trim();
    if (!trimmed) return { tool: 'search_meeting_transcript', items: [], totalCount: 0 };

    const where = {
      text: { contains: trimmed, mode: 'insensitive' as const },
      ...(meetingId ? { meetingId } : {}),
    };
    const [segments, totalCount] = await Promise.all([
      this.prisma.meetingSegment.findMany({
        where,
        select: {
          meetingId: true,
          speakerLabel: true,
          speakerEmployeeId: true,
          startMs: true,
          endMs: true,
          text: true,
          meeting: { select: { title: true } },
          speakerEmployee: { select: { fullName: true } },
        },
        orderBy: { meeting: { meetingDate: 'desc' } },
        take: MAX_TOOL_ITEMS,
      }),
      this.prisma.meetingSegment.count({ where }),
    ]);
    const items: MeetingTranscriptMatchData[] = segments.map((s) => ({
      meetingId: s.meetingId,
      meetingTitle: s.meeting.title,
      speakerLabel: s.speakerLabel,
      speakerEmployeeId: s.speakerEmployeeId,
      speakerName: s.speakerEmployee?.fullName ?? null,
      startMs: s.startMs,
      endMs: s.endMs,
      text: s.text,
    }));
    return { tool: 'search_meeting_transcript', items, totalCount };
  }
}
