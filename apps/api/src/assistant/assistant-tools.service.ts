import { Injectable, Logger } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { EventStatus, Prisma, Role, TaskFromMeetingStatus } from '@prisma/client';
import { TasksService } from '../tasks/tasks.service';
import { EventsService } from '../calendar/events.service';
import { FilesService } from '../files/files.service';
import { MeetingsService } from '../meetings/meetings.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { EmployeeResolverService } from '../employees/employee-resolver.service';
import { withLocalOffset } from '../common/timezone';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import type { TaskCardData, EventCardData, FilePartData } from './dto/message-part-data.dto';
import { buildTasksWorkbookBuffer } from './task-export';

// Тот же P2002-чек, что уже есть в assistant-chat.service.ts
// (isUniqueConstraintError) — не импортируется оттуда напрямую: это
// создало бы цикл (assistant-tools → assistant-chat → assistant-reply →
// assistant-tools). Три строки дешевле продублировать, чем городить общий
// модуль ради одной чистой функции.
function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

// Stage 2, Phase O (Meeting → Task workflow, 22.09.2026) — durable claim
// TaskFromMeetingExecution зависает в CLAIMED дольше этого порога только
// если процесс упал между claim'ом и записью COMPLETED/FAILED; создание
// одной Task — не многошаговый процесс, поэтому порог короче, чем
// STALE_VOICE_EXECUTION_MS в voice.service.ts (там между RECEIVED и
// EXECUTING может быть реальный STT+LLM-вызов).
const STALE_TASK_FROM_MEETING_MS = 60 * 1000;

// ms сегмента транскрипта → "MM:SS"/"H:MM:SS" для человекочитаемого
// Task.sourceTimestamp — нигде в проекте такого форматтера ещё нет
// (transcript UI пока не показывает startMs напрямую).
export function formatSegmentTimestamp(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${minutes}:${ss}`;
}

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
  | 'search_meeting_transcript'
  | 'create_task_from_meeting'
  | 'find_employee_by_competency';

function resolveToolName(name: string): KnownToolName {
  if (name === 'get_events') return 'get_events';
  if (name === 'export_tasks_xlsx') return 'export_tasks_xlsx';
  if (name === 'get_recent_meetings') return 'get_recent_meetings';
  if (name === 'search_meetings') return 'search_meetings';
  if (name === 'get_meeting') return 'get_meeting';
  if (name === 'search_meeting_transcript') return 'search_meeting_transcript';
  if (name === 'create_task_from_meeting') return 'create_task_from_meeting';
  if (name === 'find_employee_by_competency') return 'find_employee_by_competency';
  return 'get_tasks';
}

// roadmap v13, MUST-FIX #2 (23.09.2026) — единственное место, регистрирующее
// write-tool'ы (сейчас один, roadmap'а Phase P "Corporate Write Tools"
// добавит больше). AssistantReplyService.runReply использует это, чтобы
// считать write-only индекс для идемпотентности (см. её комментарий) —
// read-tool'ы (search_meetings/get_meeting/...) не должны сдвигать этот
// счётчик, иначе ретрай с другим числом read-вызовов даёт другой dedupeKey.
const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set(['create_task_from_meeting']);
export function isWriteTool(name: string): boolean {
  return WRITE_TOOL_NAMES.has(name);
}

// Безопасные коды для tool_result (аудит 16.09.2026, Phase F.1, P2.1) —
// расширено третьим инструментом в Phase G, тем же приёмом расширено
// четырьмя инструментами встреч/Plaud в Phase K. create_task_from_meeting
// (Phase O) — это ТОЛЬКО generic-фолбэк на непредвиденную ошибку;
// ожидаемые отказы валидации (несуществующая встреча/чужой сегмент/
// неоднозначный исполнитель) createTaskFromMeeting возвращает сама со
// своим конкретным кодом, не бросает исключение — см. её комментарий.
const TOOL_ERROR_MESSAGES: Record<KnownToolName, string> = {
  get_tasks: 'TASK_LOOKUP_FAILED: не удалось получить список задач',
  get_events: 'CALENDAR_LOOKUP_FAILED: не удалось получить события календаря',
  export_tasks_xlsx: 'EXPORT_FAILED: не удалось сформировать файл',
  get_recent_meetings: 'MEETING_LOOKUP_FAILED: не удалось получить список встреч',
  search_meetings: 'MEETING_LOOKUP_FAILED: не удалось найти встречи',
  get_meeting: 'MEETING_LOOKUP_FAILED: не удалось получить встречу',
  search_meeting_transcript: 'MEETING_LOOKUP_FAILED: не удалось найти в транскриптах',
  create_task_from_meeting: 'TASK_CREATE_FAILED: не удалось создать задачу',
  find_employee_by_competency: 'EMPLOYEE_LOOKUP_FAILED: не удалось найти сотрудников по компетенции',
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
  | { tool: 'create_task_from_meeting'; task: TaskCardData }
  | { tool: 'find_employee_by_competency'; competencyId: string; employees: { id: string; fullName: string }[] }
  | { tool: KnownToolName; error: true; message: string };

// Инструменты, которые Assistant Core (assistant-reply.service.ts) может
// предложить модели. До Phase O — только чтение, ничего не мутирует
// (спека Stage 2 §16/§33: этот этап не про изменение задач/событий
// голосом-текстом, это делает voice-модуль своим отдельным путём). Phase O
// (Meeting → Task workflow, 22.09.2026) добавляет ПЕРВЫЙ write-tool —
// create_task_from_meeting — со своей durable-идемпотентностью (см.
// createTaskFromMeeting ниже), остальные тулы по-прежнему read-only. RBAC
// — на уровне того, какие инструменты вообще ВИДИТ модель (buildTools), а
// не постфактум: get_events просто отсутствует в списке для не-OWNER,
// тот же принцип, что уже в VoiceService.parse для видимости календаря.
@Injectable()
export class AssistantToolsService {
  private readonly logger = new Logger(AssistantToolsService.name);

  constructor(
    private readonly tasks: TasksService,
    private readonly events: EventsService,
    private readonly files: FilesService,
    private readonly meetings: MeetingsService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly employeeResolver: EmployeeResolverService,
  ) {}

  // Stage 2, Phase P (Competency-based assignee routing, 22.09.2026) —
  // async ради find_employee_by_competency ниже: её схема должна нести
  // ЗАКРЫТЫЙ enum реальных competencyId (тот же принцип, что уже
  // применён в meeting-task-extraction.service.ts:43 для assigneeId —
  // модель не может сослаться на несуществующую запись), а список
  // компетенций компании — не статические данные, только из БД.
  // Единственный реальный production-вызывающий —
  // AssistantReplyService.runReply() (уже await'ит результат).
  async buildTools(user: AuthenticatedUser): Promise<Anthropic.Tool[]> {
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
        description:
          'Получить список последних встреч (протоколов), от новых к старым. Если пользователь явно говорит "Plaud" ("последняя запись из Plaud", "записи из Plaud") — используй source="plaud", чтобы отдать только встречи, реально импортированные из Plaud, а не вообще последнюю встречу любого происхождения. Для обычных вопросов вроде "какая была последняя встреча" оставляй source="all" (по умолчанию).',
        input_schema: {
          type: 'object',
          properties: {
            limit: { type: 'integer', description: 'Сколько встреч вернуть (по умолчанию 5)' },
            source: { type: 'string', enum: ['all', 'plaud'], description: 'all (по умолчанию) — любые встречи; plaud — только импортированные из Plaud' },
          },
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
      tools.push({
        name: 'create_task_from_meeting',
        description:
          'Поставить НОВУЮ задачу на основании конкретного пункта/реплики встречи — только когда пользователь ЯВНО просит создать/поставить задачу ("создай из второго пункта задачу...", "поставь ему задачу..."). Не вызывай этот инструмент просто потому, что при обсуждении встречи прозвучал потенциальный action item — только по прямой команде. meetingId обязателен (id встречи, обычно уже известен из предыдущих search_meetings/get_meeting/search_meeting_transcript в этом разговоре). segmentId — id конкретной реплики из search_meeting_transcript, если задача поставлена по конкретному сказанному, необязателен (можно не указывать, если источник — общее саммари встречи). assigneeRawText — буквальный текст имени/обращения, КАК оно прозвучало ("Жандосу", "Амиру"), НЕ приводи к именительному падежу — сервер сам сопоставит с сотрудником и переспросит, если неоднозначно; оставь пустым, если исполнитель не назван. Если пользователь называет исполнителя НЕ по имени, а по роли/обязанности ("тому, кто отвечает за X", "юристу", "бухгалтеру") — СНАЧАЛА вызови find_employee_by_competency, чтобы найти реального сотрудника, и только потом подставь сюда его настоящее полное имя. sourceContext — короткая (1-2 предложения) цитата или пересказ ПОЧЕМУ возникла эта задача, безопасно показать исполнителю без доступа к самой встрече.',
        input_schema: {
          type: 'object',
          properties: {
            meetingId: { type: 'string' },
            segmentId: { type: 'string' },
            title: { type: 'string' },
            description: { type: 'string' },
            assigneeRawText: { type: 'string' },
            dueDate: { type: 'string', description: 'ISO-дата/время, местное время пользователя без смещения, см. системную инструкцию про текущую дату' },
            sourceContext: { type: 'string' },
          },
          required: ['meetingId', 'title'],
        },
      });

      // Stage 2, Phase P (Competency-based assignee routing, 22.09.2026)
      // — Competency/EmployeeCompetency уже существовали в схеме (админка
      // сотрудников), но ничем не читались для подсказки исполнителя.
      // Закрытый enum ниже — модель не может сослаться на несуществующую
      // компетенцию; сам подбор сотрудника (0/1/много) делает backend в
      // execute(), не модель (раздел 7 спеки: LLM — не security boundary).
      const competencies = await this.prisma.competency.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true, description: true } });
      if (competencies.length > 0) {
        tools.push({
          name: 'find_employee_by_competency',
          description:
            `Найти сотрудников, отвечающих за определённую область/компетенцию — используй, когда пользователь называет исполнителя НЕ по имени, а по роли/обязанности ("тому, кто отвечает за юридические вопросы", "бухгалтеру", "ответственному за закупки"). Список компетенций компании (id — name — description):\n` +
            competencies.map((c) => `${c.id} — ${c.name} — ${c.description}`).join('\n') +
            '\nЕсли сотрудников с этой компетенцией не нашлось — честно скажи пользователю, не пытайся поставить задачу без исполнителя. Если нашлось несколько — перечисли их пользователю и спроси, кого выбрать, НЕ угадывай. Если нашёлся ровно один — можно сразу продолжить (например, вызвать create_task_from_meeting с его настоящим полным именем в assigneeRawText).',
          input_schema: {
            type: 'object',
            properties: { competencyId: { type: 'string', enum: competencies.map((c) => c.id) } },
            required: ['competencyId'],
          },
        });
      }
    }

    return tools;
  }

  async execute(
    name: string,
    input: unknown,
    user: AuthenticatedUser,
    conversationId?: string,
    userMessageId?: string,
    writeToolCallIndex?: number,
  ): Promise<ToolExecutionResult> {
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
        const typedInput = input as { limit?: unknown; source?: unknown } | null;
        const rawLimit = Number(typedInput?.limit);
        const source = typedInput?.source === 'plaud' ? 'plaud' : 'all';
        return await this.getRecentMeetings(Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 5, source);
      }
      if (name === 'search_meetings') {
        const query = (input as { query?: unknown } | null)?.query;
        return await this.searchMeetings(typeof query === 'string' ? query : '', user);
      }
      if (name === 'get_meeting') {
        const meetingId = (input as { meetingId?: unknown } | null)?.meetingId;
        return await this.getMeeting(typeof meetingId === 'string' ? meetingId : '', user);
      }
      if (name === 'search_meeting_transcript') {
        const typedInput = input as { query?: unknown; meetingId?: unknown } | null;
        const query = typeof typedInput?.query === 'string' ? typedInput.query : '';
        const meetingId = typeof typedInput?.meetingId === 'string' ? typedInput.meetingId : undefined;
        return await this.searchMeetingTranscript(query, meetingId, user);
      }
      if (name === 'create_task_from_meeting') {
        if (!conversationId || !userMessageId || writeToolCallIndex === undefined) {
          // Не должно случаться на практике — runReply прокидывает
          // writeToolCallIndex на каждый write-tool вызов (см. её
          // комментарий, roadmap v13 MUST-FIX #2). Сравнивается с undefined
          // явно, не через falsy-проверку — 0 (первый write-вызов) является
          // легитимным значением. Если всё же случилось (например, кто-то
          // вызвал execute() напрямую в обход runReply) — безопасный явный
          // отказ, не создаём задачу без идентичности для идемпотентности.
          throw new Error('create_task_from_meeting: отсутствует conversationId/userMessageId/writeToolCallIndex');
        }
        const typedInput = input as {
          meetingId?: unknown;
          segmentId?: unknown;
          title?: unknown;
          description?: unknown;
          assigneeRawText?: unknown;
          dueDate?: unknown;
          sourceContext?: unknown;
        } | null;
        return await this.createTaskFromMeeting(
          {
            meetingId: typeof typedInput?.meetingId === 'string' ? typedInput.meetingId : '',
            segmentId: typeof typedInput?.segmentId === 'string' ? typedInput.segmentId : undefined,
            title: typeof typedInput?.title === 'string' ? typedInput.title : '',
            description: typeof typedInput?.description === 'string' ? typedInput.description : undefined,
            assigneeRawText: typeof typedInput?.assigneeRawText === 'string' ? typedInput.assigneeRawText : undefined,
            dueDate: typeof typedInput?.dueDate === 'string' ? typedInput.dueDate : undefined,
            sourceContext: typeof typedInput?.sourceContext === 'string' ? typedInput.sourceContext : undefined,
          },
          user,
          conversationId,
          userMessageId,
          writeToolCallIndex,
        );
      }
      if (name === 'find_employee_by_competency') {
        const competencyId = (input as { competencyId?: unknown } | null)?.competencyId;
        return await this.findEmployeeByCompetency(typeof competencyId === 'string' ? competencyId : '');
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
  // roadmap v13, MUST-FIX #1 — source прокидывается как есть в
  // findAll(), фильтрация по Meeting.plaudRecordingId живёт там же, где
  // и остальная логика видимости встреч.
  private async getRecentMeetings(limit: number, source: 'all' | 'plaud' = 'all'): Promise<ToolExecutionResult> {
    const meetings = await this.meetings.findAll(source);
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
  private async searchMeetings(query: string, user: AuthenticatedUser): Promise<ToolExecutionResult> {
    const trimmed = query.trim();
    if (!trimmed) return { tool: 'search_meetings', items: [], totalCount: 0 };

    const where = {
      OR: [
        { title: { contains: trimmed, mode: 'insensitive' as const } },
        { rawSummary: { contains: trimmed, mode: 'insensitive' as const } },
        // Находка №4 седьмого внешнего аудита (Stage 2, Phase N) — если
        // Plaud обновил саммари, новое содержимое живёт в latestSummary,
        // не в замороженной rawSummary — поиск должен видеть его тоже.
        { latestSummary: { contains: trimmed, mode: 'insensitive' as const } },
        { enhancedSummary: { contains: trimmed, mode: 'insensitive' as const } },
      ],
    };
    const [meetings, totalCount] = await Promise.all([
      this.prisma.meeting.findMany({ where, select: { id: true, title: true, meetingDate: true }, orderBy: { meetingDate: 'desc' }, take: MAX_TOOL_ITEMS }),
      this.prisma.meeting.count({ where }),
    ]);
    const items: MeetingSummaryData[] = meetings.map((m) => ({ meetingId: m.id, title: m.title, meetingDate: m.meetingDate.toISOString() }));

    // Находка P2 (доп. пункт) седьмого внешнего аудита — поиск по встречам
    // через AI-ассистента раньше не оставлял следа в AuditLog вообще (в
    // отличие от MeetingsService.findOne/extractTasks, где раздел 15 ТЗ уже
    // соблюдался). entityId — сам поисковый запрос: у поиска по всем
    // встречам нет одной "целевой" записи, а по запросу можно найти, что
    // именно искали.
    await this.audit.log(user.id, 'AI_MEETING_SEARCH', 'Meeting', trimmed, { resultCount: totalCount });

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
        // Находка №4 седьмого внешнего аудита (Stage 2, Phase N, "Plaud
        // summary freshness") — Assistant должен отвечать по самой свежей
        // версии, не по замороженной rawSummary, если Plaud её обновил.
        summary: meeting.enhancedSummary ?? meeting.latestSummary ?? meeting.rawSummary,
      },
    };
  }

  // Stage 2, Phase K — best-effort: MeetingSegment заполняется только для
  // встреч, где формат транскрипта Plaud удалось распарсить (см.
  // предупреждение в plaud-sync.service.ts/transcript-parser.ts) — пустой
  // результат здесь означает либо "ничего не сказали по теме", либо
  // "транскрипт этой встречи ещё не синхронизирован", промпт инструмента
  // прямо просит модель не путать одно с другим и не выдумывать ответ.
  private async searchMeetingTranscript(query: string, meetingId: string | undefined, user: AuthenticatedUser): Promise<ToolExecutionResult> {
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

    // Находка P2 (доп. пункт) седьмого внешнего аудита — то же самое, что
    // AI_MEETING_SEARCH выше, для поиска по транскриптам. entityId —
    // meetingId, если поиск сужен на конкретную встречу (реальная целевая
    // запись), иначе сам запрос (поиск по всем транскриптам).
    await this.audit.log(user.id, 'AI_TRANSCRIPT_SEARCH', 'Meeting', meetingId ?? trimmed, { query: trimmed, meetingId: meetingId ?? null, resultCount: totalCount });

    return { tool: 'search_meeting_transcript', items, totalCount };
  }

  // Stage 2, Phase O (Meeting → Task workflow, 22.09.2026) — ПЕРВЫЙ
  // write-tool Assistant Core (все остальные методы выше — read-only).
  // Раздел 7 спеки Phase L: LLM — не security boundary, поэтому meeting/
  // segment/assignee здесь перепроверяются на бэкенде заново, а не берутся
  // на слово у модели, и создание идёт только через TasksService.create
  // (та же RBAC/уведомления/история, что у любой другой задачи), не
  // прямым prisma.task.create.
  //
  // Ожидаемые отказы валидации (встреча не найдена, чужой сегмент,
  // неоднозначный/не найденный исполнитель) — НЕ exceptions: метод сам
  // возвращает { error: true, message } с конкретным кодом. Единственное,
  // что долетает до generic catch-all в execute() (TOOL_ERROR_MESSAGES) —
  // непредвиденные сбои (БД недоступна и т.п.).
  private async createTaskFromMeeting(
    input: {
      meetingId: string;
      segmentId?: string;
      title: string;
      description?: string;
      assigneeRawText?: string;
      dueDate?: string;
      sourceContext?: string;
    },
    user: AuthenticatedUser,
    conversationId: string,
    userMessageId: string,
    writeToolCallIndex: number,
  ): Promise<ToolExecutionResult> {
    const meetingId = input.meetingId.trim();
    const title = input.title.trim();
    if (!meetingId || !title) {
      return { tool: 'create_task_from_meeting', error: true, message: 'INVALID_INPUT: не указана встреча или заголовок задачи' };
    }

    // Реальный доступ (404 для чужой/несуществующей) + audit READ — тот
    // же метод, что get_meeting уже переиспользует.
    let meeting: Awaited<ReturnType<MeetingsService['findOne']>>;
    try {
      meeting = await this.meetings.findOne(meetingId, user.id);
    } catch {
      return { tool: 'create_task_from_meeting', error: true, message: 'MEETING_LOOKUP_FAILED: встреча не найдена' };
    }

    // Раздел 7 спеки Phase L: сегмент, если указан, обязан принадлежать
    // ИМЕННО этой встрече — модель могла перепутать id из другого разговора
    // (или попытаться подставить чужой segmentId), доверять переданной паре
    // meetingId+segmentId без проверки небезопасно.
    let segment: { id: string; startMs: number } | null = null;
    const segmentId = input.segmentId?.trim();
    if (segmentId) {
      const found = await this.prisma.meetingSegment.findUnique({ where: { id: segmentId }, select: { id: true, meetingId: true, startMs: true } });
      if (!found || found.meetingId !== meetingId) {
        return { tool: 'create_task_from_meeting', error: true, message: 'SEGMENT_MISMATCH: указанная реплика не принадлежит этой встрече' };
      }
      segment = { id: found.id, startMs: found.startMs };
    }

    // Idempotency-claim ДО любой мутации (тот же pre/post-mutation
    // boundary, что claimAndRunDurable в voice.service.ts). Hardening-раунд
    // (22.09.2026, P0/P1) — dedupeKey больше НЕ строится из meetingId/
    // segmentId/title: title — LLM-generated текст, который модель может
    // перефразировать между попытками одного и того же ретрая (ключ тогда
    // менялся бы и ретрай не распознавался), а два РАЗНЫХ вызова в одном
    // ответе с одинаковым meetingId/title (например, один и тот же пункт
    // встречи, поставленный ДВУМ разным исполнителям) схлопывались бы в
    // один — assigneeRawText в старом ключе не участвовал вовсе. Новый
    // ключ — чисто позиционная identity: userMessageId (стабилен при
    // полном ретрае сообщения, в отличие от tool_use.id от Anthropic, см.
    // комментарий AssistantReplyService.runReply) + writeToolCallIndex
    // (номер ЭТОГО конкретного write-вызова внутри runReply, различает
    // несколько вызовов в одном ответе). roadmap v13, MUST-FIX #2
    // (23.09.2026) — раньше это был индекс СРЕДИ ВСЕХ tool-вызовов
    // (включая read-tool'ы вроде search_meetings/get_meeting), из-за чего
    // ретрай с другим числом read-вызовов перед этим же write-вызовом менял
    // индекс и ломал распознавание дубликата. Теперь runReply считает
    // отдельный счётчик, увеличивающийся только на write-tool'ах (см.
    // isWriteTool/WRITE_TOOL_NAMES выше и её комментарий) — число
    // read-вызовов между ними больше не влияет на ключ. Без хэша — обе
    // части уже безопасны как строка (userMessageId — cuid,
    // writeToolCallIndex — число, разделитель ':' не может встретиться ни
    // в одной из частей).
    const dedupeKey = `${userMessageId}:${writeToolCallIndex}`;

    let executionId: string;
    try {
      const created = await this.prisma.taskFromMeetingExecution.create({ data: { conversationId, dedupeKey } });
      executionId = created.id;
    } catch (err) {
      if (!isUniqueConstraintError(err)) throw err;
      const existing = await this.prisma.taskFromMeetingExecution.findUnique({ where: { conversationId_dedupeKey: { conversationId, dedupeKey } } });
      if (!existing) throw err;

      // Hardening-раунд (22.09.2026, P0 "crash-safe idempotency") —
      // проверяем САМУ Task через Task.sourceExecutionId (@unique — DB-
      // гарантия "максимум одна Task на execution"), не только
      // existing.status: если процесс упал МЕЖДУ prisma.task.create()
      // (ниже) и обновлением execution в COMPLETED, execution мог остаться
      // CLAIMED — но Task уже реально существует. Task-таблица надёжнее
      // как источник истины, чем execution.status, который мог не успеть
      // записаться до крэша.
      const existingTask = await this.prisma.task.findUnique({
        where: { sourceExecutionId: existing.id },
        select: { id: true, title: true, status: true, dueDate: true, assignee: { select: { id: true, fullName: true } } },
      });
      if (existingTask) {
        if (existing.status !== TaskFromMeetingStatus.COMPLETED || existing.taskId !== existingTask.id) {
          // Самоисцеление — execution не успел обновиться до крэша,
          // подтягиваем его в консистентное состояние заодно.
          await this.prisma.taskFromMeetingExecution.update({
            where: { id: existing.id },
            data: { status: TaskFromMeetingStatus.COMPLETED, taskId: existingTask.id, errorMessage: null },
          });
        }
        return { tool: 'create_task_from_meeting', task: this.buildTaskCardWithSource(existingTask, meeting, segment, input.sourceContext) };
      }

      // Task ещё нет — прежняя status-based reclaim-логика: FAILED или
      // устаревший (брошенный процесс) CLAIMED можно повторить, свежий
      // CLAIMED (реально конкурентный вызов) — безопасный отказ.
      const isStale = Date.now() - existing.updatedAt.getTime() > STALE_TASK_FROM_MEETING_MS;
      const safeToReclaim = existing.status === TaskFromMeetingStatus.FAILED || (existing.status === TaskFromMeetingStatus.CLAIMED && isStale);
      if (!safeToReclaim) {
        return { tool: 'create_task_from_meeting', error: true, message: 'ALREADY_PROCESSING: эта задача уже создаётся или недавно была создана — подождите немного' };
      }
      await this.prisma.taskFromMeetingExecution.update({ where: { id: existing.id }, data: { status: TaskFromMeetingStatus.CLAIMED, errorMessage: null, taskId: null } });
      executionId = existing.id;
    }

    // Раздел 9 спеки Phase L: assigneeMentioned + resolver !== RESOLVED →
    // задача НЕ создаётся, никакого fallback в assigneeId: null — тот же
    // принцип, что уже применяется в voice/updateSpeakers.
    let assigneeId: string | null = null;
    const assigneeRawText = input.assigneeRawText?.trim();
    if (assigneeRawText) {
      const employees = await this.prisma.employee.findMany({ where: { status: 'ACTIVE' }, select: { id: true, fullName: true } });
      const resolution = await this.employeeResolver.resolve(assigneeRawText, employees);
      if (resolution.status !== 'RESOLVED') {
        const message =
          resolution.status === 'AMBIGUOUS'
            ? 'ASSIGNEE_AMBIGUOUS: не удалось однозначно определить исполнителя — уточните у пользователя, кого из сотрудников с похожим именем он имел в виду'
            : 'ASSIGNEE_NOT_FOUND: не удалось найти сотрудника с таким именем — уточните у пользователя';
        await this.prisma.taskFromMeetingExecution.update({ where: { id: executionId }, data: { status: TaskFromMeetingStatus.FAILED, errorMessage: message } });
        return { tool: 'create_task_from_meeting', error: true, message };
      }
      assigneeId = resolution.employeeId;
    }

    const sourceTimestamp = segment ? formatSegmentTimestamp(segment.startMs) : undefined;
    const sourceContext = input.sourceContext?.trim().slice(0, 800) || undefined;

    let task: Awaited<ReturnType<TasksService['create']>>;
    try {
      task = await this.tasks.create(
        {
          title,
          description: input.description?.trim() || undefined,
          assigneeId: assigneeId ?? undefined,
          dueDate: input.dueDate ? withLocalOffset(input.dueDate) ?? undefined : undefined,
          sourceMeetingId: meetingId,
          sourceSegmentId: segment?.id,
          sourceExecutionId: executionId,
          sourceTimestamp,
          sourceContext,
        },
        user,
      );
    } catch (err) {
      const err2 = err instanceof Error ? err : new Error(String(err));
      this.logger.error(`create_task_from_meeting: не удалось создать задачу: ${err2.message}`, err2.stack);
      await this.prisma.taskFromMeetingExecution.update({ where: { id: executionId }, data: { status: TaskFromMeetingStatus.FAILED, errorMessage: err2.message } });
      return { tool: 'create_task_from_meeting', error: true, message: TOOL_ERROR_MESSAGES.create_task_from_meeting };
    }

    await this.prisma.taskFromMeetingExecution.update({ where: { id: executionId }, data: { status: TaskFromMeetingStatus.COMPLETED, taskId: task.id } });

    // Раздел 21 спеки Phase L — без транскрипта целиком, только ссылки.
    await this.audit.log(user.id, 'AI_MEETING_TASK_CREATE', 'Task', task.id, { meetingId, segmentId: segment?.id ?? null, assigneeId, dueDate: input.dueDate ?? null });

    return { tool: 'create_task_from_meeting', task: this.buildTaskCardWithSource(task, meeting, segment, input.sourceContext) };
  }

  // Общий конструктор TaskCardData.source и для только что созданной
  // задачи, и для idempotent-повтора (возврат уже существующей) — meeting/
  // segment уже провалидированы вызывающим кодом выше.
  private buildTaskCardWithSource(
    task: { id: string; title: string; status: string; dueDate: Date | null; assignee: { id: string; fullName: string } | null },
    meeting: { id: string; title: string; meetingDate: Date },
    segment: { id: string; startMs: number } | null,
    rawSourceContext: string | undefined,
  ): TaskCardData {
    return {
      ...toTaskCardData(task),
      source: {
        meetingId: meeting.id,
        meetingTitle: meeting.title,
        meetingDate: meeting.meetingDate.toISOString(),
        timestamp: segment ? formatSegmentTimestamp(segment.startMs) : null,
        context: rawSourceContext?.trim().slice(0, 800) || null,
      },
    };
  }

  // Stage 2, Phase P (Competency-based assignee routing, 22.09.2026) —
  // Competency/EmployeeCompetency уже существовали (админка сотрудников),
  // но ничем не читались для подсказки исполнителя. competencyId уже
  // провалидирован закрытым enum'ом схемы тула (buildTools) — модель не
  // могла подставить несуществующий id, но пустая строка (typeof-фолбэк
  // в execute()) всё равно защищена ниже. Backend только ЧЕСТНО отдаёт
  // список 0/1/много — раздел 7 спеки: LLM сам решает, что делать с
  // результатом (продолжить/переспросить/сказать, что никто не назначен),
  // не подбирает вместо модели.
  private async findEmployeeByCompetency(competencyId: string): Promise<ToolExecutionResult> {
    if (!competencyId) {
      return { tool: 'find_employee_by_competency', error: true, message: 'INVALID_INPUT: не указана компетенция' };
    }
    const rows = await this.prisma.employeeCompetency.findMany({
      where: { competencyId, employee: { status: 'ACTIVE' } },
      select: { employee: { select: { id: true, fullName: true } } },
    });
    const employees = rows.map((r) => r.employee);
    return { tool: 'find_employee_by_competency', competencyId, employees };
  }
}
