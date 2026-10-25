import { BadRequestException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import { EventStatus, MemoryKind, Prisma, RoutineChannel, RoutineMode, TaskFromMeetingStatus, TaskPriority, type MemoryItem } from '@prisma/client';
import { TasksService } from '../tasks/tasks.service';
import { EventsService } from '../calendar/events.service';
import { FilesService } from '../files/files.service';
import { MailQueryService, type EmailFilters } from '../mail/mail-query.service';
import { MailStore } from '../mail/mail-store';
import { MeetingsService } from '../meetings/meetings.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { EmployeeResolverService } from '../employees/employee-resolver.service';
import { withLocalOffset } from '../common/timezone';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import type { TaskCardData, EventCardData, FilePartData, MailDraftCardData, MailPlanCardData } from './dto/message-part-data.dto';
import { MailActionPlanService } from '../mail/action/mail-action-plan.service';
import { MailComposeService, type DraftView } from '../mail/mail-compose.service';
import { buildMailPlanCandidates, MAIL_TOOL_ACTION_TYPES, MAX_MAIL_TOOL_ACTIONS, parseMailToolActions, summarizeCandidates, type MailToolFolder } from './assistant-mail-actions';
import { buildTasksWorkbookBuffer } from './task-export';
import { isManager } from '../auth/roles';
import { LegalAgentError, LegalAgentService } from '../legal/legal-agent.service';
import { formatLegalAnswer, type LegalAnswer } from '../legal/legal-agent';
import { legalAllowedForRole } from '../legal/legal-access';
import { LegalReviewLimitError, LegalReviewService, type LegalReviewView, toReviewView } from '../legal/legal-review.service';
import { MemoryService } from '../memory/memory.service';
import { MEMORY_TEXT_MAX } from '../memory/memory-index';
import { RoutinesService } from '../routines/routines.service';

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
  | 'create_task'
  | 'create_task_from_meeting'
  | 'find_employee_by_competency'
  | 'search_emails'
  | 'get_email'
  | 'legal_ask'
  | 'legal_review_contract'
  | 'legal_review_status'
  | 'propose_mail_actions'
  | 'draft_mail_reply'
  | 'remember'
  | 'recall_memory'
  | 'forget_memory'
  | 'propose_routine';

function resolveToolName(name: string): KnownToolName {
  if (name === 'get_events') return 'get_events';
  if (name === 'export_tasks_xlsx') return 'export_tasks_xlsx';
  if (name === 'get_recent_meetings') return 'get_recent_meetings';
  if (name === 'search_meetings') return 'search_meetings';
  if (name === 'get_meeting') return 'get_meeting';
  if (name === 'search_meeting_transcript') return 'search_meeting_transcript';
  if (name === 'create_task') return 'create_task';
  if (name === 'create_task_from_meeting') return 'create_task_from_meeting';
  if (name === 'find_employee_by_competency') return 'find_employee_by_competency';
  if (name === 'search_emails') return 'search_emails';
  if (name === 'get_email') return 'get_email';
  if (name === 'legal_ask') return 'legal_ask';
  if (name === 'legal_review_contract') return 'legal_review_contract';
  if (name === 'legal_review_status') return 'legal_review_status';
  if (name === 'propose_mail_actions') return 'propose_mail_actions';
  if (name === 'draft_mail_reply') return 'draft_mail_reply';
  if (name === 'remember') return 'remember';
  if (name === 'recall_memory') return 'recall_memory';
  if (name === 'forget_memory') return 'forget_memory';
  if (name === 'propose_routine') return 'propose_routine';
  return 'get_tasks';
}

// roadmap v13, MUST-FIX #2 (23.09.2026) — единственное место, регистрирующее
// write-tool'ы (сейчас один, roadmap'а Phase P "Corporate Write Tools"
// добавит больше). AssistantReplyService.runReply использует это, чтобы
// считать write-only индекс для идемпотентности (см. её комментарий) —
// read-tool'ы (search_meetings/get_meeting/...) не должны сдвигать этот
// счётчик, иначе ретрай с другим числом read-вызовов даёт другой dedupeKey.
// legal_review_contract (агент-юрист) ставит платное фоновое задание —
// тоже write: его ключ идемпотентности строится из writeToolCallIndex.
// Почта, этап 3: propose_mail_actions/draft_mail_reply сами ничего не
// исполняют (план и черновик ждут кнопки), но создают записи — их ключ
// тоже строится из writeToolCallIndex.
// Память (ARMS, фаза 1): remember создаёт пункт — ключ идемпотентности из
// writeToolCallIndex; forget_memory меняет данные — порядок важен.
// Регламенты (ARMS, фаза 4): propose_routine создаёт черновик — ключ из writeToolCallIndex.
const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set(['create_task', 'create_task_from_meeting', 'legal_review_contract', 'propose_mail_actions', 'draft_mail_reply', 'remember', 'forget_memory', 'propose_routine']);
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
  create_task: 'TASK_CREATE_FAILED: не удалось создать задачу',
  create_task_from_meeting: 'TASK_CREATE_FAILED: не удалось создать задачу',
  find_employee_by_competency: 'EMPLOYEE_LOOKUP_FAILED: не удалось найти сотрудников по компетенции',
  search_emails: 'MAIL_LOOKUP_FAILED: не удалось найти письма',
  get_email: 'MAIL_LOOKUP_FAILED: не удалось получить письмо',
  legal_ask: 'LEGAL_FAILED: агент-юрист не смог подготовить ответ',
  legal_review_contract: 'LEGAL_REVIEW_FAILED: не удалось запустить разбор договора',
  legal_review_status: 'LEGAL_REVIEW_LOOKUP_FAILED: не удалось получить статус разборов',
  propose_mail_actions: 'MAIL_PLAN_FAILED: не удалось подготовить действия с письмами',
  draft_mail_reply: 'MAIL_DRAFT_FAILED: не удалось подготовить письмо',
  remember: 'MEMORY_SAVE_FAILED: не удалось сохранить в память',
  recall_memory: 'MEMORY_LOOKUP_FAILED: не удалось проверить память',
  forget_memory: 'MEMORY_FORGET_FAILED: не удалось убрать пункт из памяти',
  propose_routine: 'ROUTINE_PROPOSE_FAILED: не удалось подготовить регламент',
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
// Release 2 (Mail.ru Email Intelligence) — те же принципы, что Meeting-tools
// выше: чтение только через MailQueryService (источник правды — локальная
// БД, не runtime-запрос к Mail.ru), никакого write-tool'а (у провайдера нет
// SMTP — нечего писать).
export interface MailToolEmailSummary {
  emailId: string;
  subject: string | null;
  fromAddress: string;
  fromName: string | null;
  receivedAt: string | null;
  importance: string | null;
  needsReply: boolean | null;
  summary: string | null;
}
export interface MailToolEmailDetail extends MailToolEmailSummary {
  textBody: string | null;
  actionSummary: string | null;
}

// Память (ARMS, фаза 1) — пункт в том виде, в каком его видит модель.
export interface MemoryToolItem {
  id: string;
  kind: MemoryKind;
  text: string;
}

function toMemoryToolItem(item: MemoryItem): MemoryToolItem {
  return { id: item.id, kind: item.kind, text: item.text };
}

const MEMORY_KINDS: MemoryKind[] = ['PREFERENCE', 'FACT', 'PERSON', 'RULE', 'CONTEXT'];

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
  | { tool: 'create_task'; task: TaskCardData }
  | { tool: 'create_task_from_meeting'; task: TaskCardData }
  | { tool: 'find_employee_by_competency'; competencyId: string; employees: { id: string; fullName: string }[] }
  | { tool: 'search_emails'; items: MailToolEmailSummary[]; totalCount: number }
  | { tool: 'get_email'; email: MailToolEmailDetail }
  // Агент-юрист: markdown собран сервером из проверенных цитат и
  // показывается пользователю отдельной частью (assistant-render.ts).
  | { tool: 'legal_ask'; answer: LegalAnswer; markdown: string }
  | { tool: 'legal_review_contract'; review: LegalReviewView; alreadyStarted: boolean }
  | { tool: 'legal_review_status'; items: LegalReviewView[] }
  | { tool: 'propose_mail_actions'; plans: MailPlanCardData[]; unknownEmailIds: string[] }
  | { tool: 'draft_mail_reply'; draft: MailDraftCardData }
  | { tool: 'remember'; item: MemoryToolItem; duplicate: boolean; replaced: MemoryToolItem | null; similar: MemoryToolItem[] }
  | { tool: 'recall_memory'; items: (MemoryToolItem & { details: string | null })[]; totalCount: number }
  | { tool: 'forget_memory'; item: MemoryToolItem }
  | { tool: 'propose_routine'; routine: { id: string; title: string; schedule: string | null; mode: RoutineMode; channel: RoutineChannel } }
  | { tool: KnownToolName; error: true; message: string };

// Что видит модель чата в tool_result. Ответ агента-юриста ей не отдаётся:
// живая проверка 21.10.2026 — Haiku пересказывал вывод своими словами, хотя
// промпт просил одну фразу, а пересказ норм — ровно то, чего юр-агент
// избегает. Пользователь видит ответ отдельным блоком (assistant-render.ts),
// в историю беседы он попадает оттуда же — уточняющие вопросы не теряют
// контекст.
export function toolResultForModel(result: ToolExecutionResult): unknown {
  if ('error' in result) return { error: result.message };
  if (result.tool === 'legal_ask') {
    return {
      shown_to_user: true,
      norms_cited: result.answer.citations.length,
      note: 'Ответ юриста с нормами и цитатами интерфейс покажет пользователю отдельным блоком сразу под твоим сообщением. Напиши одно короткое предложение-связку, не пересказывай вывод и нормы.',
    };
  }
  if (result.tool === 'propose_mail_actions') {
    return {
      ...result,
      executed: false,
      note: 'Ничего ещё не выполнено. Пользователь видит карточку со списком действий и кнопкой «Подтвердить» — выполнится только после неё. Коротко скажи, что подготовил, и попроси подтвердить; не пиши, что письма уже перемещены.',
    };
  }
  if (result.tool === 'draft_mail_reply') {
    return {
      ...result,
      sent: false,
      note: 'Письмо НЕ отправлено. Пользователь видит карточку с текстом письма и кнопкой «Отправить» — уйдёт только после неё. Не повторяй текст письма целиком, коротко скажи, что черновик готов к проверке.',
    };
  }
  if (result.tool === 'remember') {
    const note = result.duplicate
      ? 'Почти такой же пункт уже был в памяти — новый не создан. Скажи, что это уже помнишь.'
      : result.similar.length > 0
        ? 'Сохранено. В памяти есть похожие пункты (similar) — если новый их заменяет, коротко спроси пользователя, убрать ли старые (forget_memory).'
        : 'Сохранено в память. Коротко подтверди одной фразой.';
    return { ...result, note };
  }
  if (result.tool === 'propose_routine') {
    return {
      ...result,
      enabled: false,
      note: 'Это черновик: регламент ещё не работает. Руководитель проверит и включит его на странице «Регламенты». Коротко скажи, что подготовил (что, когда, куда присылать), и куда зайти, чтобы включить.',
    };
  }
  return result;
}

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
    private readonly mailStore: MailStore,
    private readonly mailQuery: MailQueryService,
    // Агент-юрист — необязательные зависимости: без них (юнит-тесты,
    // выключенный флаг) юр-инструменты просто не предлагаются.
    @Optional() private readonly legal?: LegalAgentService,
    @Optional() private readonly config?: ConfigService,
    @Optional() private readonly legalReviews?: LegalReviewService,
    // Почта, этап 3 — без них (юнит-тесты) пишущие почтовые инструменты не предлагаются.
    @Optional() private readonly mailPlans?: MailActionPlanService,
    @Optional() private readonly mailCompose?: MailComposeService,
    // Память (ARMS, фаза 1) — без неё (юнит-тесты) инструменты памяти не предлагаются.
    @Optional() private readonly memory?: MemoryService,
    // Регламенты (ARMS, фаза 4) — без них propose_routine не предлагается.
    @Optional() private readonly routines?: RoutinesService,
  ) {}

  // Память — сначала руководству (план ARMS: всё новое — OWNER/ADMIN).
  memoryAvailable(user: AuthenticatedUser): boolean {
    return !!this.memory && isManager(user.role);
  }

  private legalAvailable(user: AuthenticatedUser): boolean {
    return !!this.legal && !!this.config && legalAllowedForRole(this.config, user.role);
  }

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
    if (isManager(user.role)) {
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
      // 25.10.2026: обычная задача без встречи — раньше в чате (и в голосе,
      // если разбор принял команду за вопрос) её поставить было нечем, и
      // модель отвечала, что задачи создаются только из протоколов.
      tools.push({
        name: 'create_task',
        description:
          'Поставить НОВУЮ задачу, когда пользователь прямо просит поставить/создать/поручить задачу ("поставь Рустему задачу...", "создай задачу...", "поручи Асель..."). Если задача — пункт конкретной встречи, используй create_task_from_meeting. assigneeRawText — имя исполнителя КАК оно прозвучало ("Рустему", "на Рустема"), без приведения к именительному падежу; пусто — задача на самого пользователя. Если исполнитель назван по роли ("юристу") — сначала find_employee_by_competency. dueDate — местное время без смещения; если назван только день ("завтра"), ставь 18:00 этого дня. Просьба в форме вопроса с конкретным исполнителем и делом («как поставить задачу на Рустема, чтобы он завтра сходил в магазин», «можешь поручить Асель…») — тоже просьба поставить: ставь. Не вызывай только на общий вопрос, как пользоваться задачами, без конкретного дела.',
        input_schema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Коротко, в повелительной форме: «Сходить в магазин»' },
            description: { type: 'string' },
            assigneeRawText: { type: 'string' },
            dueDate: { type: 'string', description: 'ISO-дата/время, местное время пользователя без смещения' },
            priority: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH'], description: 'Только если назван' },
          },
          required: ['title'],
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

      // Release 2 (Mail.ru Email Intelligence) — почта личная (один
      // MailStore-ящик на владельца, весь MailController закрыт на OWNER,
      // как календарь) — те же условия видимости, что у get_events выше,
      // не отдельная проверка.
      tools.push({
        name: 'search_emails',
        description:
          'Найти письма в подключённой почте руководителя по фильтрам — отправитель, тема/текст, важность, статус ответа, дата. Используй для вопросов вида "есть что-то важное в почте", "что писал X", "какие письма ждут ответа". Если почта не подключена — инструмент честно сообщит об этом, не выдумывай письма.',
        input_schema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Поиск по теме/тексту/отправителю' },
            sender: { type: 'string', description: 'Отправитель — адрес или имя (подстрока)' },
            dateFrom: { type: 'string', format: 'date-time' },
            dateTo: { type: 'string', format: 'date-time' },
            importance: { type: 'array', items: { type: 'string', enum: ['CRITICAL', 'IMPORTANT', 'NORMAL', 'LOW'] } },
            needsReply: { type: 'boolean', description: 'true — только письма, требующие ответа руководителя' },
            readStatus: { type: 'string', enum: ['read', 'unread', 'all'] },
          },
          required: [],
        },
      });
      tools.push({
        name: 'get_email',
        description: 'Получить полный текст и AI-анализ одного письма по его id (обычно из search_emails).',
        input_schema: {
          type: 'object',
          properties: { emailId: { type: 'string' } },
          required: ['emailId'],
        },
      });
      if (this.mailPlans) {
        tools.push({
          name: 'propose_mail_actions',
          description:
            'Предложить действия с конкретными письмами: в архив, переместить в папку, в корзину, отметить прочитанным/непрочитанным, поставить/снять флажок. Вызывай, когда пользователь просит навести порядок или что-то сделать с письмами. Ничего не выполняется сразу: пользователь увидит карточку и подтвердит её кнопкой. emailId — только из результатов search_emails/get_email, не выдумывай. ARCHIVE работает в любом ящике: если папки для архива нет, при подтверждении она будет создана — не спрашивай пользователя про папку. MOVE — folderPath обязателен и должен быть существующей папкой ящика (если папка не найдена, инструмент вернёт список папок). Для остальных действий folderPath — null. Каждая просьба что-то сделать с письмом — новый вызов, даже если раньше похожий план не выполнился.',
          input_schema: {
            type: 'object',
            properties: {
              request: { type: 'string', description: 'Просьба пользователя одной фразой — заголовок плана' },
              actions: {
                type: 'array',
                maxItems: MAX_MAIL_TOOL_ACTIONS,
                items: {
                  type: 'object',
                  properties: {
                    emailId: { type: 'string' },
                    type: { type: 'string', enum: [...MAIL_TOOL_ACTION_TYPES] },
                    folderPath: { type: ['string', 'null'] },
                    reason: { type: 'string', description: 'Коротко, почему именно это письмо' },
                  },
                  required: ['emailId', 'type', 'folderPath', 'reason'],
                },
              },
            },
            required: ['request', 'actions'],
          },
        });
      }
      if (this.mailCompose) {
        tools.push({
          name: 'draft_mail_reply',
          description:
            'Подготовить ответ или пересылку конкретного письма. Письмо НЕ отправляется: пользователь увидит карточку с текстом и сам нажмёт «Отправить» или поправит. Вызывай, когда просят ответить, написать ответ, переслать. emailId — из search_emails/get_email. mode: reply — ответить отправителю, reply_all — ответить всем, forward — переслать (тогда to обязателен: адреса получателей). body — только твой текст письма, без цитаты исходного (цитату и тему «Re:/Fwd:» сервер добавит сам), без подписи-заглушки вроде «[Ваше имя]». Пиши от лица пользователя, вежливо и по делу, в стиле деловой переписки.',
          input_schema: {
            type: 'object',
            properties: {
              emailId: { type: 'string' },
              mode: { type: 'string', enum: ['reply', 'reply_all', 'forward'] },
              body: { type: 'string' },
              to: { type: 'array', items: { type: 'string' }, description: 'Только для forward — адреса получателей' },
            },
            required: ['emailId', 'mode', 'body'],
          },
        });
      }
    }

    // Агент-юрист (handoff 21.10.2026) — доступен всем ролям, пока
    // LEGAL_AGENT_ROLES пуст; флаг LEGAL_AGENT_ENABLED выключен — инструмента нет.
    if (this.legalAvailable(user)) {
      tools.push({
        name: 'legal_ask',
        description:
          'Вопрос по законодательству Республики Казахстан (гражданское, строительное, земельное, трудовое, налоговое право, долевое участие, госзакупки и др.) — отвечает агент-юрист строго по базе НПА с дословными цитатами статей. Используй для любых юридических вопросов: сроки, гарантии, неустойки, ответственность, формы договоров, права и обязанности сторон. Ответ занимает 1–2 минуты. Передай вопрос пользователя полностью, с деталями ситуации.',
        input_schema: {
          type: 'object',
          properties: {
            question: { type: 'string', description: 'Юридический вопрос пользователя с контекстом ситуации' },
          },
          required: ['question'],
        },
      });
      if (this.legalReviews) {
        tools.push({
          name: 'legal_review_contract',
          description:
            'Запустить разбор договора агентом-юристом в интересах генподрядчика: находки по пунктам, правки, нормы с цитатами и отчёт Word. Используй, когда пользователь прикрепил договор (PDF или DOCX, пометка [attached_file] или ранее [file]) и просит проверить/разобрать/оценить его. Разбор идёт в фоне 5–10 минут; итог с отчётом придёт в эту беседу сам — скажи об этом пользователю. Содержимое файла ты не видишь — его читает агент-юрист.',
          input_schema: {
            type: 'object',
            properties: {
              fileId: { type: 'string', description: 'id файла договора из пометки [attached_file] или [file]' },
              focus: { type: 'string', description: 'На что пользователь просит обратить особое внимание (если сказал); иначе пустая строка' },
            },
            required: ['fileId'],
          },
        });
        tools.push({
          name: 'legal_review_status',
          description: 'Статус последних разборов договоров пользователя (в очереди / идёт / готов / ошибка). Используй, когда спрашивают, готов ли разбор.',
          input_schema: { type: 'object', properties: {} },
        });
      }
    }

    if (this.memoryAvailable(user)) {
      tools.push(
        {
          name: 'remember',
          description:
            'Сохранить в долговременную память ассистента сведение или предпочтение пользователя. Вызывай, когда пользователь просит запомнить («запомни», «впредь», «я предпочитаю», «всегда/никогда делай…») или сообщает устойчивый факт о себе, людях, компании. Один вызов — одна мысль, коротко, от третьего лица («Отчёты присылать в xlsx, не в pdf»). Если новое уточняет или противоречит пункту из блока [memory] — передай его id в replacesId: старый пункт уйдёт в архив. Разовые поручения и задачи сюда не сохраняй.',
          input_schema: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: MEMORY_KINDS, description: 'PREFERENCE — предпочтение, RULE — правило работы, PERSON — о человеке, FACT — факт о компании/делах, CONTEXT — длительный контекст' },
              text: { type: 'string', maxLength: MEMORY_TEXT_MAX, description: 'Суть одной фразой' },
              details: { type: 'string', description: 'Необязательные подробности' },
              replacesId: { type: 'string', description: 'id пункта из [memory], который этот заменяет' },
            },
            required: ['kind', 'text'],
          },
        },
        {
          name: 'recall_memory',
          description:
            'Поиск в памяти ассистента по словам — для подробностей, которых нет в блоке [memory] (он показывает только краткий список). Используй, когда ответ может зависеть от сохранённых сведений, а в [memory] их не видно.',
          input_schema: {
            type: 'object',
            properties: { query: { type: 'string', description: 'Ключевые слова' } },
            required: ['query'],
          },
        },
        {
          name: 'forget_memory',
          description: 'Убрать пункт из памяти ассистента (в архив), когда пользователь просит забыть или пункт устарел. id — из блока [memory] или результата recall_memory.',
          input_schema: {
            type: 'object',
            properties: { id: { type: 'string', description: 'id пункта памяти' } },
            required: ['id'],
          },
        },
      );
    }

    if (this.routines && isManager(user.role)) {
      tools.push({
        name: 'propose_routine',
        description:
          'Подготовить черновик регламента — поручения, которое ассистент будет сам выполнять по расписанию («каждый понедельник в 9:00 присылай…», «каждый день проверяй…»). Вызывай, когда пользователь просит что-то делать регулярно. Ничего не включается сразу: пользователь проверит черновик и включит его на странице «Регламенты».',
        input_schema: {
          type: 'object',
          properties: {
            title: { type: 'string', maxLength: 80, description: 'Короткое название, 2–6 слов' },
            instructions: { type: 'string', description: 'Что делать в каждом прогоне: что проверить, что считать важным, в каком виде прислать' },
            days: { type: 'array', items: { type: 'integer', minimum: 1, maximum: 7 }, description: 'Дни недели: 1 — понедельник … 7 — воскресенье; каждый день — все семь' },
            time: { type: 'string', description: 'Время по Алматы, ЧЧ:ММ' },
            mode: { type: 'string', enum: ['ACTIVE', 'PASSIVE'], description: 'ACTIVE — присылать итог всегда (сводки, отчёты); PASSIVE — писать только если нашлось важное (проверки, «следи за…»)' },
            channel: { type: 'string', enum: ['FEED', 'TELEGRAM', 'BOTH'], description: 'Куда присылать: FEED — в ассистент, TELEGRAM — в Telegram, BOTH — оба. По умолчанию TELEGRAM' },
          },
          required: ['title', 'instructions', 'days', 'time', 'mode', 'channel'],
        },
      });
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
        return await this.getTasks(filter === 'overdue' ? 'overdue' : 'all');
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
      if (name === 'create_task') {
        if (!conversationId || !userMessageId || writeToolCallIndex === undefined) {
          throw new Error('create_task: отсутствует conversationId/userMessageId/writeToolCallIndex');
        }
        const typedInput = (input ?? {}) as { title?: unknown; description?: unknown; assigneeRawText?: unknown; dueDate?: unknown; priority?: unknown };
        return await this.createTask(
          {
            title: typeof typedInput.title === 'string' ? typedInput.title : '',
            description: typeof typedInput.description === 'string' ? typedInput.description : undefined,
            assigneeRawText: typeof typedInput.assigneeRawText === 'string' ? typedInput.assigneeRawText : undefined,
            dueDate: typeof typedInput.dueDate === 'string' ? typedInput.dueDate : undefined,
            priority: typedInput.priority === 'LOW' || typedInput.priority === 'MEDIUM' || typedInput.priority === 'HIGH' ? TaskPriority[typedInput.priority] : undefined,
          },
          user,
          conversationId,
          userMessageId,
          writeToolCallIndex,
        );
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
      if (name === 'search_emails') return await this.searchEmails(input, user);
      if (name === 'get_email') {
        const emailId = (input as { emailId?: unknown } | null)?.emailId;
        return await this.getEmail(typeof emailId === 'string' ? emailId : '', user);
      }
      if (name === 'propose_mail_actions' || name === 'draft_mail_reply') {
        if (!userMessageId || writeToolCallIndex === undefined) {
          // Как у create_task_from_meeting: без идентичности вызова нет ключа идемпотентности.
          throw new Error(`${name}: отсутствует userMessageId/writeToolCallIndex`);
        }
        const key = `chat:${userMessageId}:${writeToolCallIndex}`;
        return name === 'propose_mail_actions' ? await this.proposeMailActions(input, user, key) : await this.draftMailReply(input, user, key);
      }
      if (name === 'legal_ask') {
        const question = (input as { question?: unknown } | null)?.question;
        return await this.legalAsk(typeof question === 'string' ? question : '', user);
      }
      if (name === 'legal_review_contract') {
        if (!conversationId || !userMessageId || writeToolCallIndex === undefined) {
          // Как у create_task_from_meeting: без идентичности вызова нет
          // ключа идемпотентности — платное задание не ставим.
          throw new Error('legal_review_contract: отсутствует conversationId/userMessageId/writeToolCallIndex');
        }
        const typedInput = input as { fileId?: unknown; focus?: unknown } | null;
        return await this.legalReviewContract(
          typeof typedInput?.fileId === 'string' ? typedInput.fileId : '',
          typeof typedInput?.focus === 'string' ? typedInput.focus : '',
          user,
          conversationId,
          `chat:${userMessageId}:${writeToolCallIndex}`,
        );
      }
      if (name === 'legal_review_status') return await this.legalReviewStatus(user);
      if (name === 'propose_routine') return await this.proposeRoutine(input, user, userMessageId, writeToolCallIndex);
      if (name === 'remember' || name === 'recall_memory' || name === 'forget_memory') {
        return await this.runMemoryTool(name, input, user, userMessageId, writeToolCallIndex);
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

  // Регламенты (ARMS, фаза 4): только черновик — включает человек.
  // Неверные поля — понятная модели ошибка, а не исключение.
  private async proposeRoutine(input: unknown, user: AuthenticatedUser, userMessageId: string | undefined, writeToolCallIndex: number | undefined): Promise<ToolExecutionResult> {
    if (!this.routines || !isManager(user.role)) return { tool: 'propose_routine', error: true, message: 'ROUTINE_UNAVAILABLE: регламенты недоступны' };
    if (!userMessageId || writeToolCallIndex === undefined) throw new Error('propose_routine: отсутствует userMessageId/writeToolCallIndex');
    const typed = (input ?? {}) as { title?: unknown; instructions?: unknown; days?: unknown; time?: unknown; mode?: unknown; channel?: unknown };
    const days = Array.isArray(typed.days) ? typed.days.filter((d): d is number => typeof d === 'number') : [];
    try {
      const routine = await this.routines.proposeDraft(
        user.id,
        {
          title: typeof typed.title === 'string' ? typed.title : '',
          prompt: typeof typed.instructions === 'string' ? typed.instructions : '',
          days,
          time: typeof typed.time === 'string' ? typed.time.padStart(5, '0') : '',
          mode: typed.mode === 'PASSIVE' ? RoutineMode.PASSIVE : RoutineMode.ACTIVE,
          channel: typed.channel === 'FEED' ? RoutineChannel.FEED : typed.channel === 'BOTH' ? RoutineChannel.BOTH : RoutineChannel.TELEGRAM,
        },
        `chat:${userMessageId}:${writeToolCallIndex}`,
      );
      return { tool: 'propose_routine', routine: { id: routine.id, title: routine.title, schedule: routine.schedule, mode: routine.mode, channel: routine.channel } };
    } catch (err) {
      if (err instanceof BadRequestException) return { tool: 'propose_routine', error: true, message: `INVALID_INPUT: ${err.message}` };
      throw err;
    }
  }

  // Память (ARMS, фаза 1). Доступ перепроверяется здесь (роль могла смениться
  // после истории), владелец пункта — в MemoryService: чужой id = «не найден».
  private async runMemoryTool(
    name: 'remember' | 'recall_memory' | 'forget_memory',
    input: unknown,
    user: AuthenticatedUser,
    userMessageId: string | undefined,
    writeToolCallIndex: number | undefined,
  ): Promise<ToolExecutionResult> {
    if (!this.memory || !this.memoryAvailable(user)) {
      return { tool: name, error: true, message: 'MEMORY_UNAVAILABLE: память недоступна' };
    }
    const typed = (input ?? {}) as { kind?: unknown; text?: unknown; details?: unknown; replacesId?: unknown; query?: unknown; id?: unknown };
    if (name === 'recall_memory') {
      const { items, totalCount } = await this.memory.recall(user.id, typeof typed.query === 'string' ? typed.query : '');
      return { tool: 'recall_memory', items: items.map((i) => ({ ...toMemoryToolItem(i), details: i.details })), totalCount };
    }
    if (name === 'forget_memory') {
      const id = typeof typed.id === 'string' ? typed.id.trim() : '';
      try {
        return { tool: 'forget_memory', item: toMemoryToolItem(await this.memory.forget(user.id, id)) };
      } catch (err) {
        if (err instanceof NotFoundException) return { tool: 'forget_memory', error: true, message: 'MEMORY_NOT_FOUND: такого пункта в памяти нет' };
        throw err;
      }
    }
    if (!userMessageId || writeToolCallIndex === undefined) {
      // Как у create_task_from_meeting: без идентичности вызова нет ключа идемпотентности.
      throw new Error('remember: отсутствует userMessageId/writeToolCallIndex');
    }
    const kind = MEMORY_KINDS.includes(typed.kind as MemoryKind) ? (typed.kind as MemoryKind) : MemoryKind.FACT;
    const text = typeof typed.text === 'string' ? typed.text.trim() : '';
    if (text.length < 2) return { tool: 'remember', error: true, message: 'INVALID_INPUT: пустой текст пункта памяти' };
    try {
      const result = await this.memory.remember(
        user.id,
        {
          kind,
          text,
          details: typeof typed.details === 'string' ? typed.details : undefined,
          replacesId: typeof typed.replacesId === 'string' && typed.replacesId.trim() ? typed.replacesId.trim() : undefined,
        },
        `chat:${userMessageId}:${writeToolCallIndex}`,
      );
      return {
        tool: 'remember',
        item: toMemoryToolItem(result.item),
        duplicate: result.duplicate,
        replaced: result.replaced ? toMemoryToolItem(result.replaced) : null,
        similar: result.similar.map(toMemoryToolItem),
      };
    } catch (err) {
      if (err instanceof NotFoundException) return { tool: 'remember', error: true, message: 'MEMORY_NOT_FOUND: заменяемого пункта в памяти нет' };
      throw err;
    }
  }

  // Видимость перепроверяется и здесь: модель могла вызвать инструмент из
  // старой истории, хотя флаг уже выключен.
  private async legalAsk(question: string, user: AuthenticatedUser): Promise<ToolExecutionResult> {
    if (!this.legal || !this.legalAvailable(user)) {
      return { tool: 'legal_ask', error: true, message: 'LEGAL_UNAVAILABLE: агент-юрист недоступен' };
    }
    if (question.trim().length < 3) return { tool: 'legal_ask', error: true, message: 'LEGAL_EMPTY_QUESTION: не передан вопрос' };
    try {
      const answer = await this.legal.ask(question);
      void this.audit.log(user.id, 'LEGAL_ASK', 'LegalQuestion', 'assistant', {
        rounds: answer.rounds,
        citations: answer.citations.length,
        unverified: answer.citations.filter((c) => !c.verified).length,
      });
      return { tool: 'legal_ask', answer, markdown: formatLegalAnswer(answer) };
    } catch (err) {
      if (err instanceof LegalAgentError) {
        this.logger.warn(`legal_ask: ${err.code} ${err.message}`);
        return { tool: 'legal_ask', error: true, message: TOOL_ERROR_MESSAGES.legal_ask };
      }
      throw err;
    }
  }

  private async legalReviewContract(
    fileId: string,
    focus: string,
    user: AuthenticatedUser,
    conversationId: string,
    dedupeKey: string,
  ): Promise<ToolExecutionResult> {
    const tool = 'legal_review_contract' as const;
    if (!this.legalReviews || !this.legalAvailable(user)) return { tool, error: true, message: 'LEGAL_UNAVAILABLE: агент-юрист недоступен' };
    try {
      const { run, created } = await this.legalReviews.create(user, { fileId, focus, conversationId, dedupeKey });
      if (created) void this.audit.log(user.id, 'LEGAL_REVIEW_REQUESTED', 'LegalReviewRun', run.id, { fileId: run.fileId, source: 'assistant' });
      return { tool, review: toReviewView(run), alreadyStarted: !created };
    } catch (err) {
      // Ожидаемые отказы — конкретным кодом, модель объяснит их пользователю.
      if (err instanceof NotFoundException) return { tool, error: true, message: 'LEGAL_FILE_NOT_FOUND: файл договора не найден — попросите прикрепить его' };
      if (err instanceof LegalReviewLimitError) return { tool, error: true, message: 'LEGAL_REVIEW_LIMIT: уже идут 3 разбора — нужно дождаться их завершения' };
      if (err instanceof BadRequestException) return { tool, error: true, message: 'LEGAL_UNSUPPORTED_FILE: для разбора нужен договор в PDF или DOCX' };
      throw err;
    }
  }

  private async legalReviewStatus(user: AuthenticatedUser): Promise<ToolExecutionResult> {
    if (!this.legalReviews || !this.legalAvailable(user)) {
      return { tool: 'legal_review_status', error: true, message: 'LEGAL_UNAVAILABLE: агент-юрист недоступен' };
    }
    return { tool: 'legal_review_status', items: await this.legalReviews.list(user, 5) };
  }

  private async getTasks(filter: GetTasksFilter = 'all'): Promise<ToolExecutionResult> {
    const tasks = await this.tasks.findAll();
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
    const tasks = await this.tasks.findAll();
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
    // Ключ — `${userMessageId}:${writeToolCallIndex}` (claimTaskExecution).
    const claim = await this.claimTaskExecution(conversationId, `${userMessageId}:${writeToolCallIndex}`);
    if ('busy' in claim) {
      return { tool: 'create_task_from_meeting', error: true, message: 'ALREADY_PROCESSING: эта задача уже создаётся или недавно была создана — подождите немного' };
    }
    if ('existingTask' in claim) {
      return { tool: 'create_task_from_meeting', task: this.buildTaskCardWithSource(claim.existingTask, meeting, segment, input.sourceContext) };
    }
    const executionId = claim.executionId;

    // Раздел 9 спеки Phase L: assigneeMentioned + resolver !== RESOLVED →
    // задача НЕ создаётся, никакого fallback в assigneeId: null — тот же
    // принцип, что уже применяется в voice/updateSpeakers.
    const assignee = await this.resolveAssigneeForExecution(input.assigneeRawText, executionId);
    if ('message' in assignee) return { tool: 'create_task_from_meeting', error: true, message: assignee.message };
    const assigneeId = assignee.assigneeId;

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

  // Обычная задача из чата (25.10.2026) — та же идемпотентность и тот же
  // подбор исполнителя, что у create_task_from_meeting, без source-полей
  // встречи. Только руководство (инструмент выдаётся в buildTools).
  private async createTask(
    input: { title: string; description?: string; assigneeRawText?: string; dueDate?: string; priority?: TaskPriority },
    user: AuthenticatedUser,
    conversationId: string,
    userMessageId: string,
    writeToolCallIndex: number,
  ): Promise<ToolExecutionResult> {
    const title = input.title.trim();
    if (!title) return { tool: 'create_task', error: true, message: 'INVALID_INPUT: не указан заголовок задачи' };
    if (!isManager(user.role)) return { tool: 'create_task', error: true, message: 'TASK_CREATE_FORBIDDEN: ставить задачи из чата может только руководство' };

    const claim = await this.claimTaskExecution(conversationId, `${userMessageId}:${writeToolCallIndex}`);
    if ('busy' in claim) return { tool: 'create_task', error: true, message: 'ALREADY_PROCESSING: эта задача уже создаётся — подождите немного' };
    if ('existingTask' in claim) return { tool: 'create_task', task: toTaskCardData(claim.existingTask) };
    const executionId = claim.executionId;

    const assignee = await this.resolveAssigneeForExecution(input.assigneeRawText, executionId);
    if ('message' in assignee) return { tool: 'create_task', error: true, message: assignee.message };

    let task: Awaited<ReturnType<TasksService['create']>>;
    try {
      task = await this.tasks.create(
        {
          title,
          description: input.description?.trim() || undefined,
          assigneeId: assignee.assigneeId ?? undefined,
          dueDate: input.dueDate ? (withLocalOffset(input.dueDate) ?? undefined) : undefined,
          priority: input.priority,
          sourceExecutionId: executionId,
        },
        user,
      );
    } catch (err) {
      const err2 = err instanceof Error ? err : new Error(String(err));
      this.logger.error(`create_task: не удалось создать задачу: ${err2.message}`, err2.stack);
      await this.prisma.taskFromMeetingExecution.update({ where: { id: executionId }, data: { status: TaskFromMeetingStatus.FAILED, errorMessage: err2.message } });
      return { tool: 'create_task', error: true, message: TOOL_ERROR_MESSAGES.create_task };
    }
    await this.prisma.taskFromMeetingExecution.update({ where: { id: executionId }, data: { status: TaskFromMeetingStatus.COMPLETED, taskId: task.id } });
    await this.audit.log(user.id, 'AI_TASK_CREATE', 'Task', task.id, { assigneeId: assignee.assigneeId, dueDate: input.dueDate ?? null });
    return { tool: 'create_task', task: toTaskCardData(task) };
  }

  // Durable claim одного write-вызова «поставить задачу» (идемпотентность
  // по conversationId + dedupeKey). Таблица названа по первому
  // пользователю — create_task_from_meeting; create_task делит её же.
  private async claimTaskExecution(
    conversationId: string,
    dedupeKey: string,
  ): Promise<{ executionId: string } | { existingTask: { id: string; title: string; status: string; dueDate: Date | null; assignee: { id: string; fullName: string } | null } } | { busy: true }> {
    try {
      const created = await this.prisma.taskFromMeetingExecution.create({ data: { conversationId, dedupeKey } });
      return { executionId: created.id };
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
        return { existingTask };
      }

      // Task ещё нет — прежняя status-based reclaim-логика: FAILED или
      // устаревший (брошенный процесс) CLAIMED можно повторить, свежий
      // CLAIMED (реально конкурентный вызов) — безопасный отказ.
      const isStale = Date.now() - existing.updatedAt.getTime() > STALE_TASK_FROM_MEETING_MS;
      const safeToReclaim = existing.status === TaskFromMeetingStatus.FAILED || (existing.status === TaskFromMeetingStatus.CLAIMED && isStale);
      if (!safeToReclaim) return { busy: true };
      await this.prisma.taskFromMeetingExecution.update({ where: { id: existing.id }, data: { status: TaskFromMeetingStatus.CLAIMED, errorMessage: null, taskId: null } });
      return { executionId: existing.id };
    }
  }

  // Исполнитель по тексту из реплики; не нашли однозначно — execution FAILED
  // и понятная модели ошибка (задача без исполнителя не создаётся).
  private async resolveAssigneeForExecution(rawText: string | undefined, executionId: string): Promise<{ assigneeId: string | null } | { message: string }> {
    const assigneeRawText = rawText?.trim();
    if (!assigneeRawText) return { assigneeId: null };
    const employees = await this.prisma.employee.findMany({ where: { status: 'ACTIVE' }, select: { id: true, fullName: true } });
    const resolution = await this.employeeResolver.resolve(assigneeRawText, employees);
    if (resolution.status === 'RESOLVED') return { assigneeId: resolution.employeeId };
    const message =
      resolution.status === 'AMBIGUOUS'
        ? 'ASSIGNEE_AMBIGUOUS: не удалось однозначно определить исполнителя — уточните у пользователя, кого из сотрудников с похожим именем он имел в виду'
        : 'ASSIGNEE_NOT_FOUND: не удалось найти сотрудника с таким именем — уточните у пользователя';
    await this.prisma.taskFromMeetingExecution.update({ where: { id: executionId }, data: { status: TaskFromMeetingStatus.FAILED, errorMessage: message } });
    return { message };
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

  // Release 2 — "почта не подключена" это ожидаемое состояние (не у
  // каждого владельца ящик подключён в данный момент), не исключение —
  // тот же принцип, что INVALID_INPUT/ASSIGNEE_NOT_FOUND в
  // createTaskFromMeeting выше: явный { error: true } результат, а не
  // throw, чтобы модель могла честно сказать пользователю, а не показать
  // общую "TOOL_ERROR".
  // Все ящики пользователя (владелец 23.10.2026: их может быть несколько) —
  // поиск и чтение идут по всем сразу.
  private async requireMailboxId(user: AuthenticatedUser): Promise<string[] | { error: true; message: string }> {
    const mailboxes = await this.mailStore.listMailboxesByEmployee(user.id);
    if (mailboxes.length === 0) return { error: true, message: 'MAIL_NOT_CONNECTED: почта не подключена' };
    return mailboxes.map((m) => m.id);
  }

  private toMailToolSummary(item: {
    id: string;
    subject: string | null;
    fromAddress: string;
    fromName: string | null;
    receivedAt: Date | null;
    analysis: { summary: string | null; importance: string | null; needsReply: boolean | null } | null;
  }): MailToolEmailSummary {
    return {
      emailId: item.id,
      subject: item.subject,
      fromAddress: item.fromAddress,
      fromName: item.fromName,
      receivedAt: item.receivedAt ? item.receivedAt.toISOString() : null,
      importance: item.analysis?.importance ?? null,
      needsReply: item.analysis?.needsReply ?? null,
      summary: item.analysis?.summary ?? null,
    };
  }

  private async searchEmails(input: unknown, user: AuthenticatedUser): Promise<ToolExecutionResult> {
    const mailboxId = await this.requireMailboxId(user);
    if (!Array.isArray(mailboxId)) return { tool: 'search_emails', ...mailboxId };

    const typed = input as {
      query?: unknown;
      sender?: unknown;
      dateFrom?: unknown;
      dateTo?: unknown;
      importance?: unknown;
      needsReply?: unknown;
      readStatus?: unknown;
    } | null;
    const date = (v: unknown) => (typeof v === 'string' && !Number.isNaN(new Date(v).getTime()) ? new Date(v) : undefined);
    const importances = ['CRITICAL', 'IMPORTANT', 'NORMAL', 'LOW'];
    const rawReadStatus = typed?.readStatus;
    const filters: EmailFilters = {
      query: typeof typed?.query === 'string' ? typed.query : undefined,
      sender: typeof typed?.sender === 'string' ? typed.sender : undefined,
      dateFrom: date(typed?.dateFrom),
      dateTo: date(typed?.dateTo),
      importance: Array.isArray(typed?.importance)
        ? (typed.importance.filter((i): i is string => typeof i === 'string' && importances.includes(i)) as EmailFilters['importance'])
        : undefined,
      needsReply: typeof typed?.needsReply === 'boolean' ? typed.needsReply : undefined,
      readStatus: rawReadStatus === 'read' || rawReadStatus === 'unread' ? rawReadStatus : undefined,
      direction: 'incoming',
    };

    const { items, totalCount } = await this.mailQuery.search(mailboxId, filters, { limit: MAX_TOOL_ITEMS });
    await this.audit.log(user.id, 'AI_MAIL_SEARCH', 'EmailMessage', filters.query || filters.sender || 'all', { resultCount: totalCount });
    return { tool: 'search_emails', items: items.map((i) => this.toMailToolSummary(i)), totalCount };
  }

  private async getEmail(emailId: string, user: AuthenticatedUser): Promise<ToolExecutionResult> {
    const mailboxId = await this.requireMailboxId(user);
    if (!Array.isArray(mailboxId)) return { tool: 'get_email', ...mailboxId };
    if (!emailId) return { tool: 'get_email', error: true, message: 'INVALID_INPUT: не указан id письма' };

    const message = await this.mailQuery.getMessage(mailboxId, emailId);
    await this.audit.log(user.id, 'AI_MAIL_READ', 'EmailMessage', emailId, {});
    return {
      tool: 'get_email',
      email: {
        ...this.toMailToolSummary(message),
        textBody: message.textBody,
        actionSummary: message.analysis?.actionSummary ?? null,
      },
    };
  }

  // Почта, этап 3 — план действий на каждый затронутый ящик; исполнение
  // только после «Подтвердить» в карточке (тот же движок согласования, что
  // вкладка «Разбор» на /mail).
  private async proposeMailActions(input: unknown, user: AuthenticatedUser, key: string): Promise<ToolExecutionResult> {
    const mailboxIds = await this.requireMailboxId(user);
    if (!Array.isArray(mailboxIds)) return { tool: 'propose_mail_actions', ...mailboxIds };
    const typed = input as { request?: unknown; actions?: unknown } | null;
    const actions = parseMailToolActions(typed?.actions);
    if (actions.length === 0) return { tool: 'propose_mail_actions', error: true, message: 'INVALID_INPUT: нет ни одного корректного действия' };

    const messages = await this.prisma.emailMessage.findMany({
      where: { id: { in: [...new Set(actions.map((a) => a.emailId))] }, mailboxId: { in: mailboxIds } },
      select: { id: true, mailboxId: true, uid: true, folder: { select: { path: true, uidValidity: true } } },
    });
    const foldersByMailbox = new Map<string, MailToolFolder[]>();
    for (const mailboxId of new Set(messages.map((m) => m.mailboxId))) {
      foldersByMailbox.set(mailboxId, await this.mailStore.listFolders(mailboxId));
    }
    const draft = buildMailPlanCandidates(actions, messages, foldersByMailbox);
    if (draft.missingFolders.length > 0) {
      const available = [...new Set([...foldersByMailbox.values()].flatMap((f) => f.map((x) => x.path)))].join(', ');
      return {
        tool: 'propose_mail_actions',
        error: true,
        message: `FOLDER_NOT_FOUND: нет папки ${[...new Set(draft.missingFolders)].map((f) => `«${f}»`).join(', ')}. Папки ящика: ${available || '(нет)'}. Выбери существующую или спроси пользователя.`,
      };
    }
    if (draft.byMailbox.size === 0) return { tool: 'propose_mail_actions', error: true, message: 'EMAIL_NOT_FOUND: письма не найдены в почте пользователя — найди их через search_emails' };

    const request = typeof typed?.request === 'string' && typed.request.trim() ? typed.request.trim() : 'Действия с письмами';
    const plans: MailPlanCardData[] = [];
    for (const [mailboxId, candidates] of draft.byMailbox) {
      const mailbox = await this.mailStore.findOwnedMailbox(user.id, mailboxId);
      if (!mailbox) continue;
      const plan = await this.mailPlans!.createReadyPlan(user.id, mailboxId, request, candidates, `${key}:${mailboxId}`);
      plans.push({ planId: plan.id, mailboxId, mailboxAddress: mailbox.emailAddress, actions: summarizeCandidates(candidates), itemCount: candidates.length });
    }
    await this.audit.log(user.id, 'AI_MAIL_PLAN_PROPOSED', 'MailActionPlan', plans.map((p) => p.planId).join(','), { itemCount: plans.reduce((n, p) => n + p.itemCount, 0) });
    return { tool: 'propose_mail_actions', plans, unknownEmailIds: draft.unknownEmailIds };
  }

  // Почта, этап 3 — черновик ответа/пересылки; уходит только по кнопке
  // «Отправить» в карточке (POST /mail/drafts/:id/send, аудит MAIL_SENT там).
  private async draftMailReply(input: unknown, user: AuthenticatedUser, key: string): Promise<ToolExecutionResult> {
    const mailboxIds = await this.requireMailboxId(user);
    if (!Array.isArray(mailboxIds)) return { tool: 'draft_mail_reply', ...mailboxIds };
    const typed = input as { emailId?: unknown; mode?: unknown; body?: unknown; to?: unknown } | null;
    const modes = { reply: 'REPLY', reply_all: 'REPLY_ALL', forward: 'FORWARD' } as const;
    const mode = typeof typed?.mode === 'string' && typed.mode in modes ? modes[typed.mode as keyof typeof modes] : null;
    const body = typeof typed?.body === 'string' ? typed.body.trim() : '';
    const to = Array.isArray(typed?.to) ? typed.to.filter((a): a is string => typeof a === 'string') : [];
    if (typeof typed?.emailId !== 'string' || !mode || !body) return { tool: 'draft_mail_reply', error: true, message: 'INVALID_INPUT: нужны emailId, mode и body' };
    if (mode === 'FORWARD' && to.length === 0) return { tool: 'draft_mail_reply', error: true, message: 'MISSING_RECIPIENTS: для пересылки укажи адреса в to — спроси пользователя, кому переслать' };

    const message = await this.prisma.emailMessage.findFirst({ where: { id: typed.emailId, mailboxId: { in: mailboxIds } }, select: { mailboxId: true } });
    if (!message) return { tool: 'draft_mail_reply', error: true, message: 'EMAIL_NOT_FOUND: письмо не найдено в почте пользователя' };
    const owned = await this.mailStore.findOwnedMailbox(user.id, message.mailboxId);
    const mailbox = owned ? await this.mailStore.getMailbox(owned.id) : null;
    if (!mailbox) return { tool: 'draft_mail_reply', error: true, message: 'EMAIL_NOT_FOUND: письмо не найдено в почте пользователя' };

    let draft: DraftView;
    try {
      draft = await this.mailCompose!.create(mailbox, mode, typed.emailId, { body, to: mode === 'FORWARD' ? to : undefined, sourceKey: key });
    } catch (err) {
      if (err instanceof BadRequestException) return { tool: 'draft_mail_reply', error: true, message: `INVALID_INPUT: ${err.message}` };
      throw err;
    }
    await this.audit.log(user.id, 'AI_MAIL_DRAFT_PREPARED', 'MailDraft', draft.id, { mode });
    return { tool: 'draft_mail_reply', draft: { draftId: draft.id, mailboxId: mailbox.id, mode, subject: draft.subject, to: draft.to } };
  }
}
