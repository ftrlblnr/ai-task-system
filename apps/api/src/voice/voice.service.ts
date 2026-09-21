import { randomUUID } from 'crypto';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { MessagePartType, MessageRole, MessageStatus, Prisma, Role, UndoKind, UndoRecordAction, UndoRecordStatus, VoiceExecutionStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { TasksService } from '../tasks/tasks.service';
import { EventsService } from '../calendar/events.service';
import type { CreateTaskDto } from '../tasks/dto/create-task.dto';
import type { UpdateTaskDto } from '../tasks/dto/update-task.dto';
import type { CreateEventDto } from '../calendar/dto/create-event.dto';
import type { UpdateEventDto } from '../calendar/dto/update-event.dto';
import { formatLocalDateTime } from '../common/timezone';
import { AssistantChatService, isUniqueConstraintError, serializeMessageForModelContext, type MessageWithParts } from '../assistant/assistant-chat.service';
import { EmployeeResolverService } from '../employees/employee-resolver.service';
import { CompanyVocabularyService } from '../employees/company-vocabulary.service';
import { stripLeakedContextMarkers } from '../assistant/assistant-reply.service';
import { toResponseMessage } from '../assistant/assistant-response.mapper';
import { WhisperService } from './whisper.service';
import { DraftExtractionService, MAX_DRAFTS_PER_NOTE, type VoiceHistoryItem } from './draft-extraction.service';
import { buildVoiceAssistantParts, resolveClarificationReason } from './voice-render';
import type {
  EventRevertPayload,
  TaskRevertPayload,
  VoiceActionResult,
  VoiceDraft,
  VoiceEventActionDraft,
  VoiceParseResponse,
  VoiceTaskActionDraft,
} from './dto/voice-draft-response.dto';
import type { VoiceUndoDto } from './dto/voice-undo.dto';

// Минимальные структурные формы, нужные toTaskCardData/toEventCardData
// (assistant-tools.service.ts) — TasksService.create/update и
// EventsService.create/update возвращают разные select'ы, но оба —
// надмножество этих полей (см. комментарий у toTaskCardData).
export interface TaskCardEntity {
  id: string;
  title: string;
  status: string;
  dueDate: Date | null;
  assignee: { id: string; fullName: string } | null;
}
export interface EventCardEntity {
  id: string;
  title: string;
  startAt: Date;
  endAt: Date;
  location: string | null;
  participants: { id: string; fullName: string }[];
}

// Stage 2, Phase H — пара "результат для фронтенда" + "свежая сущность для
// карточки", собираемая исполнением одного черновика. entity — только для
// ok=true task_action/event_action с action create/update (voice-render.ts
// строит по нему TASK_CARD/EVENT_CARD); во всех остальных случаях (chat,
// ok=false, delete) — null, рендер идёт по одному result без сущности.
export interface ExecutedVoiceAction {
  result: VoiceActionResult;
  entity: TaskCardEntity | EventCardEntity | null;
}

// HttpException'ы (ForbiddenException/NotFoundException/BadRequestException
// и т.п.) везде в проекте конструируются с обычной строкой — .message уже
// человекочитаемый текст, тот же, что ушёл бы клиенту при вызове через
// HTTP. Раньше эти же сообщения пользователь видел как ответ на PATCH/
// DELETE с фронтенда (аудит 10.09.2026, п. 2.11) — теперь мутация внутри
// parse(), но текст ошибки в чате должен остаться тем же.
function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Не удалось выполнить действие';
}

// Тот же приём, что toJson в assistant-render.ts/voice-render.ts —
// VoiceActionResult[] формально не совместим с Prisma.InputJsonValue (у
// него index signature, у named-типов нет), хотя структурно это обычный
// плоский JSON (см. комментарий там же).
function toJson<T>(value: T): Prisma.InputJsonValue {
  return value as unknown as Prisma.InputJsonValue;
}

// Тот же приём, что isUniqueConstraintError в assistant-chat.service.ts —
// P2025 = "запись, подходящая под where, не найдена" (Prisma.update/delete).
// Используется в undo() ниже как атомарный claim: update() с
// where: {id, consumedAt: null} — если запись уже отменена конкурентным
// запросом, where больше не matches, Prisma бросает P2025 вместо того,
// чтобы молча обновить нулём строк.
function isRecordNotFoundError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025';
}

type MulterFile = Express.Multer.File;

// Сколько задач/событий максимум класть в контекст модели — не весь архив,
// иначе на компании с историей в сотни задач промпт (и, соответственно,
// задержка ответа) растёт без пользы: вопрос "какой статус у задачи Х"
// почти всегда про недавнее/актуальное, не про то, что было полгода назад.
const MAX_CONTEXT_TASKS = 40;
const MAX_CONTEXT_EVENTS = 40;
const EVENT_LOOKAHEAD_DAYS = 30;

// Память голосового диалога (аудит 10.09.2026, п. 2.9). Оба лимита разом:
// не только последние N реплик, но и не старше 3 часов — иначе "перенеси
// на вторник", сказанное с утра, случайно подхватило бы контекст заметки
// из позавчерашнего дня только потому, что она попала в последние 20 строк
// у пользователя с редкой активностью. 3 часа — обычный рабочий перерыв
// (например, обед) всё ещё "тот же разговор", ночь — уже нет.
const VOICE_HISTORY_LIMIT = 20;
const VOICE_HISTORY_MAX_AGE_MS = 3 * 60 * 60 * 1000;

// Окно "Отменить" (владелец 10.09.2026) — раньше проверялось только на
// фронте (кнопка скрывалась таймером); Stage 2, Phase H.4 переносит саму
// границу на сервер (UndoRecord.expiresAt), фронтенд по-прежнему скрывает
// кнопку тем же таймером для UX, но POST /voice/undo больше не доверяет
// одному только отсутствию клика вовремя.
const UNDO_WINDOW_MS = 30_000;

@Injectable()
export class VoiceService {
  private readonly logger = new Logger(VoiceService.name);

  constructor(
    private readonly whisper: WhisperService,
    private readonly extraction: DraftExtractionService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly tasks: TasksService,
    private readonly events: EventsService,
    private readonly assistantChat: AssistantChatService,
    // Stage 2, Phase I (внешний аудит 21.09.2026, "Employee Resolver") —
    // последний параметр, не переставлен в середину списка: существующие
    // позиционные вызовы конструктора (много в voice.service.spec.ts) не
    // ломаются, для тестов, где assigneeMentioned всегда false, этот
    // параметр можно даже не мокать (resolveAssigneeMention до него не
    // достаёт, см. её ранний return).
    private readonly employeeResolver: EmployeeResolverService,
    // Stage 2, Phase I (внешний аудит 21.09.2026, "Company/STT
    // vocabulary") — тот же принцип, последний параметр.
    private readonly vocabulary: CompanyVocabularyService,
  ) {}

  // Exactly-once для голосовых мутаций (Stage 2, Phase H.1 → H.3, третий
  // внешний аудит 21.09.2026, P0 "durable voice execution lifecycle").
  // Этот in-memory Map — только БЫСТРЫЙ ПУТЬ для конкурентных запросов
  // ВНУТРИ одного живого процесса (тот же приём, что
  // AssistantChatService.claimOrJoin): второй "по-настоящему одновременный"
  // запрос с тем же ключом просто ждёт тот же промис вместо повторного
  // Whisper/Claude round-trip'а к БД. Реальная гарантия корректности —
  // durable VoiceExecution (см. claimAndRunDurable ниже): unique(conversationId,
  // clientRequestId) на уровне БД переживает рестарт процесса, чего этот
  // Map сам по себе никогда не мог (аудит прямо указал на этот пробел —
  // findCachedParseResponse из Phase H.1 ловил только ПОСЛЕДОВАТЕЛЬНЫЙ
  // повтор после того, как прошлая попытка полностью сохранилась, но не
  // ловил ни конкурентный повтор без этого Map, ни повтор ПОСЛЕ падения/
  // рестарта процесса — VoiceExecution закрывает оба случая разом). Ключ —
  // `${conversationId}:${clientRequestId}`, не просто clientRequestId — на
  // случай, если один сотрудник когда-нибудь получит несколько разговоров.
  private readonly inFlightParseRequests = new Map<string, Promise<VoiceParseResponse>>();

  async parse(
    audio: MulterFile | undefined,
    user: AuthenticatedUser,
    meetingId: string | undefined,
    clientRequestId: string,
    conversationId?: string,
  ): Promise<VoiceParseResponse> {
    // fileFilter в FileInterceptor отклоняет неподдерживаемый mime через
    // cb(null, false) — файл молча не попадает в запрос, а не кидает ошибку,
    // поэтому здесь audio может быть undefined и это нужно проверять явно.
    if (!audio) {
      throw new BadRequestException('Аудио не получено или формат файла не поддерживается');
    }

    // Замеры по этапам (владелец 10.09.2026, по итогам анализа задержки
    // голосового пути; расширено 15.09.2026, observability-этап — раздел 2
    // ТЗ этапа) — без них любая дальнейшая оптимизация промпта или модели
    // была бы гаданием. requestId — единственный correlation id на весь
    // voice request, им помечены обе лог-строки этого запроса (эта и
    // draft-extraction ниже) — по нему грепается весь путь одной записи.
    const t0 = Date.now();
    const requestId = randomUUID();
    const audioBytes = audio.buffer.length;

    // Stage 2, Phase H — голос и текст пишут в один и тот же разговор
    // сотрудника. Резолвится до общего Promise.all ниже (а не внутри него):
    // getOrCreatePrimaryConversation в редком случае (первое голосовое
    // сообщение вообще) сам создаёт строку в БД — короткая, не зависящая от
    // Whisper/контекста операция, не стоит искусственно распараллеливать её
    // с loadHistory, которому нужен уже готовый conversation.id.
    //
    // conversationId (Stage 2, Phase H.1, внешний аудит 20.09.2026, P2) —
    // если клиент уже знает, какой разговор у него открыт, пишем именно
    // туда (assertOwnedConversation — та же проверка владения, что у
    // текстового чата, 404 на чужой/несуществующий разговор). Без него —
    // прежнее поведение (последний по updatedAt), обратная совместимость с
    // apps/web, который его не передаёт.
    const conversation = conversationId
      ? await this.assistantChat.assertOwnedConversation(user, conversationId).then(() => ({ id: conversationId }))
      : await this.assistantChat.getOrCreatePrimaryConversation(user);

    // Claim — синхронная проверка карты и запись в неё СРАЗУ, без await
    // между ними (тот же приём и то же обоснование корректности, что у
    // claimOrJoin в assistant-chat.service.ts: Node не может прервать этот
    // участок ради другого таска, поэтому два "по-настоящему одновременных"
    // запроса не могут оба проскочить проверку). Реальный claim (durable,
    // на уровне БД) — уже ВНУТРИ застолблённого выполнения
    // (claimAndRunDurable), не до него — иначе await там же открыл бы то
    // самое окно для интерливинга.
    const claimKey = `${conversation.id}:${clientRequestId}`;
    const existingInFlight = this.inFlightParseRequests.get(claimKey);
    if (existingInFlight) return existingInFlight;

    const promise = this.claimAndRunDurable(audio, user, meetingId, clientRequestId, conversation, requestId, t0, audioBytes).finally(() => {
      if (this.inFlightParseRequests.get(claimKey) === promise) {
        this.inFlightParseRequests.delete(claimKey);
      }
    });
    this.inFlightParseRequests.set(claimKey, promise);
    return promise;
  }

  // Durable exactly-once claim (Stage 2, Phase H.3, внешний аудит
  // 21.09.2026, P0) — заменяет старый findCachedParseResponse. Разница:
  // findCachedParseResponse смотрел на Message-строки (побочный эффект
  // персистентности) и не мог отличить "действие не выполнялось" от
  // "действие выполнилось, но история переписки не сохранилась" — единственный
  // безопасный выход тогда был удалить незавершённую строку и выполнить
  // ВСЁ заново, включая уже случившуюся бизнес-мутацию. VoiceExecution —
  // отдельная durable запись именно о жизненном цикле САМОГО ВЫПОЛНЕНИЯ
  // (RECEIVED → PROCESSING → EXECUTING → COMPLETED/FAILED/
  // NEEDS_RECONCILIATION, см. runParse), не о том, сохранилась ли история.
  //
  // unique(conversationId, clientRequestId) в БД — второй, независимый
  // уровень защиты от гонки (первый — inFlightParseRequests выше): даже
  // если два по-настоящему параллельных запроса как-то проскочили Map
  // (например, второй процесс API, если это когда-нибудь перестанет быть
  // однопроцессным приложением), create() у ровно одного из них успеет
  // первым, второй получит P2002 и уйдёт в ветку ниже вместо повторного
  // исполнения.
  private async claimAndRunDurable(
    audio: MulterFile,
    user: AuthenticatedUser,
    meetingId: string | undefined,
    clientRequestId: string,
    conversation: { id: string },
    requestId: string,
    t0: number,
    audioBytes: number,
  ): Promise<VoiceParseResponse> {
    let execution: Awaited<ReturnType<typeof this.prisma.voiceExecution.create>>;
    try {
      execution = await this.prisma.voiceExecution.create({
        data: { employeeId: user.id, conversationId: conversation.id, clientRequestId, status: VoiceExecutionStatus.RECEIVED },
      });
    } catch (err) {
      if (!isUniqueConstraintError(err)) throw err;
      const existing = await this.prisma.voiceExecution.findUnique({
        where: { conversationId_clientRequestId: { conversationId: conversation.id, clientRequestId } },
      });
      if (!existing) throw err;

      if (existing.status === VoiceExecutionStatus.COMPLETED) {
        return this.reconstructCompletedResponse(existing);
      }
      if (existing.status !== VoiceExecutionStatus.FAILED) {
        // RECEIVED/PROCESSING/EXECUTING/NEEDS_RECONCILIATION — небезопасно
        // трогать бизнес-логику: либо предыдущая попытка ещё реально
        // выполняется (маловероятно при пойманном inFlightParseRequests
        // выше, но возможно сразу после рестарта процесса, когда Map уже
        // пуст, а строка в БД осталась от незавершённой попытки), либо
        // упала где-то посередине выполнения действий (NEEDS_RECONCILIATION)
        // — в обоих случаях слепой повтор рискует выполнить мутацию дважды
        // или наложиться на ещё идущую. Явный отказ без единого вызова
        // TasksService/EventsService — тот же принцип "не трогать бизнес-
        // логику при неуверенности", что и defensive RBAC-проверка в undo().
        throw new BadRequestException(
          'Предыдущая попытка обработать эту голосовую команду ещё выполняется или прервалась не до конца — подождите немного и попробуйте снова; если задача/событие уже появились, повторно диктовать не нужно.',
        );
      }
      // FAILED — до этого момента НИ ОДНО действие ещё не выполнялось (см.
      // runParse: FAILED ставится только из loadContextAndExtract, ДО
      // цикла исполнения черновиков) — безопасно начать заново на той же
      // строке (не create() новую — та же уникальность всё равно упадёт).
      execution = await this.prisma.voiceExecution.update({
        where: { id: existing.id },
        data: { status: VoiceExecutionStatus.RECEIVED, errorMessage: null },
      });
    }

    return this.runParse(audio, user, meetingId, conversation, requestId, t0, audioBytes, clientRequestId, execution.id);
  }

  // Реконструкция ответа на COMPLETED (Stage 2, Phase H.3) — resultJson
  // несёт ВЕСЬ ответ, включая настоящие results (в отличие от старого
  // findCachedParseResponse, который на попадании в кэш всегда отдавал
  // пустой массив). userMessage/assistantMessage перечитываются по
  // сохранённым id, а не хранятся в resultJson целиком — они и так уже
  // есть в БД, дублировать их в JSON незачем; оба поля могут быть null,
  // если персистентность в исходной попытке не удалась (Phase H.1) — в
  // этом случае действия всё равно были выполнены и results настоящие.
  private async reconstructCompletedResponse(execution: {
    conversationId: string;
    resultJson: unknown;
    userMessageId: string | null;
    assistantMessageId: string | null;
  }): Promise<VoiceParseResponse> {
    const cached = execution.resultJson as {
      transcript: string;
      confidence: 'HIGH' | 'MEDIUM' | 'LOW';
      clarificationNeeded: boolean;
      clarificationReason: string | null;
      results: VoiceActionResult[];
    };
    const [userMessage, assistantMessage] = await Promise.all([
      execution.userMessageId
        ? this.prisma.message.findUnique({ where: { id: execution.userMessageId }, include: { parts: { orderBy: { order: 'asc' } } } })
        : Promise.resolve(null),
      execution.assistantMessageId
        ? this.prisma.message.findUnique({ where: { id: execution.assistantMessageId }, include: { parts: { orderBy: { order: 'asc' } } } })
        : Promise.resolve(null),
    ]);
    return {
      transcript: cached.transcript,
      confidence: cached.confidence,
      clarificationNeeded: cached.clarificationNeeded,
      clarificationReason: cached.clarificationReason,
      results: cached.results,
      conversationId: userMessage ? execution.conversationId : null,
      userMessage: userMessage ? toResponseMessage(userMessage) : null,
      assistantMessage: assistantMessage ? toResponseMessage(assistantMessage) : null,
    };
  }

  // STT + контекст (сотрудники/задачи/события/история) + draft extraction —
  // выделено в отдельный метод (Stage 2, Phase H.3), чтобы runParse мог
  // обернуть именно эту фазу в try/catch и пометить VoiceExecution как
  // FAILED, если она упадёт: до этой точки НИКАКИХ бизнес-мутаций ещё не
  // было, значит retry с тем же clientRequestId безопасен (см. claimAndRunDurable).
  private async loadContextAndExtract(
    audio: MulterFile,
    user: AuthenticatedUser,
    meetingId: string | undefined,
    conversation: { id: string },
    requestId: string,
  ) {
    // Whisper и вся БД-часть контекста не зависят друг от друга — раньше
    // шли строго последовательно (расшифровка → сотрудники → задачи →
    // события), хотя ни один из этих запросов не читает transcript. Раньше
    // они были в одном плоском Promise.all и мерялись одной цифрой
    // (contextMs); теперь каждая ветка обёрнута в свой IIFE с собственным
    // таймером, а внешний Promise.all по-прежнему держит их конкурентными —
    // раздел 2 ТЗ этапа явно требует не превращать параллельные операции в
    // последовательные ради измерения. meetingContext/visibleEvents —
    // Promise.resolve(...) в false-ветке, не голый []: раньше это и было
    // причиной отказа от Promise.all (смешение Promise<Event[]> и [])
    // схлопывало тип в never.
    let sttMs = 0;
    let contextDbMs = 0;
    const [{ text: transcript, durationMs: audioDurationMs }, [meetingContext, employees, visibleTasks, visibleEvents, history]] =
      await Promise.all([
        (async () => {
          const start = Date.now();
          // Stage 2, Phase I (внешний аудит 21.09.2026, "Company/STT
          // vocabulary") — обычно кэшировано (CompanyVocabularyService,
          // TTL 10 минут), поэтому не превращает эту ветку в дорогой
          // последовательный запрос к БД перед каждой транскрипцией.
          const prompt = await this.vocabulary.getPrompt();
          const result = await this.whisper.transcribe(audio.buffer, audio.mimetype, audio.originalname, prompt);
          sttMs = Date.now() - start;
          return result;
        })(),
        (async () => {
          const start = Date.now();
          const result = await Promise.all([
            // Диктовка со страницы встречи (владелец 09.09.2026) — доступно
            // только руководителю (сам /meetings и так открыт лишь ему),
            // тот же принцип, что sourceMeetingId-проверка в
            // TasksService.create(). Прямой prisma-запрос, а не
            // MeetingsService.findOne() — тот пишет audit-log READ на
            // каждый вызов, здесь это не нужный побочный эффект.
            meetingId && user.role === Role.OWNER
              ? this.prisma.meeting.findUnique({
                  where: { id: meetingId },
                  select: { title: true, rawSummary: true, enhancedSummary: true },
                })
              : Promise.resolve(null),
            this.prisma.employee.findMany({
              where: { status: 'ACTIVE' },
              select: { id: true, fullName: true },
            }),
            // Те же findAll, что отдают обычные списки задач/календаря в UI
            // — те же правила видимости (сотрудник видит своё, руководитель
            // — всё; календарь целиком закрыт на OWNER), без отдельной
            // копии RBAC здесь.
            this.tasks.findAll(user),
            user.role === Role.OWNER ? this.events.findAll(user.id) : Promise.resolve([]),
            this.loadHistory(conversation.id),
          ]);
          contextDbMs = Date.now() - start;
          return result;
        })(),
      ]);

    const taskContext = visibleTasks.slice(0, MAX_CONTEXT_TASKS).map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      assigneeName: t.assignee?.fullName ?? null,
      dueDate: t.dueDate ? formatLocalDateTime(t.dueDate) : null,
    }));

    const now = new Date();
    const lookaheadCutoff = new Date(now.getTime() + EVENT_LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000);
    const eventContext = visibleEvents
      .filter((e) => e.startAt >= now && e.startAt <= lookaheadCutoff)
      .slice(0, MAX_CONTEXT_EVENTS)
      .map((e) => ({
        id: e.id,
        title: e.title,
        location: e.location,
        startAt: formatLocalDateTime(e.startAt),
        endAt: formatLocalDateTime(e.endAt),
        allDay: e.allDay,
      }));

    const result = await this.extraction.extract(
      transcript,
      employees,
      user.role,
      taskContext,
      eventContext,
      meetingContext
        ? { title: meetingContext.title, summary: meetingContext.enhancedSummary ?? meetingContext.rawSummary }
        : null,
      history,
      requestId,
    );

    return { transcript, audioDurationMs, sttMs, contextDbMs, meetingContext, employees, taskContext, eventContext, result };
  }

  // Тело фактического разбора — выполняется не более одного раза на
  // (conversationId, clientRequestId) одновременно, см. claim в parse()
  // выше. clientRequestId/executionId здесь нужны только для итоговой
  // записи userMessage/VoiceExecution (идемпотентность на уровне БД,
  // recovery на гонку — см. userMessagePromise ниже), сам разбор от них
  // не зависит.
  private async runParse(
    audio: MulterFile,
    user: AuthenticatedUser,
    meetingId: string | undefined,
    conversation: { id: string },
    requestId: string,
    t0: number,
    audioBytes: number,
    clientRequestId: string,
    executionId: string,
  ): Promise<VoiceParseResponse> {
    await this.prisma.voiceExecution
      .update({ where: { id: executionId }, data: { status: VoiceExecutionStatus.PROCESSING } })
      .catch(() => {});
    let loaded: Awaited<ReturnType<typeof this.loadContextAndExtract>>;
    try {
      loaded = await this.loadContextAndExtract(audio, user, meetingId, conversation, requestId);
    } catch (err) {
      // Ничего не выполнено — retry с тем же clientRequestId безопасен
      // (claimAndRunDurable разрешает повтор только на FAILED).
      await this.prisma.voiceExecution
        .update({ where: { id: executionId }, data: { status: VoiceExecutionStatus.FAILED, errorMessage: toErrorMessage(err) } })
        .catch(() => {});
      throw err;
    }
    const { transcript, audioDurationMs, sttMs, contextDbMs, meetingContext, employees, taskContext, eventContext, result } = loaded;

    // Реплика пользователя (Stage 2, Phase H) — пишется в ту же ленту, что и
    // текстовый чат, не в отдельную VoiceMessage. Запущено здесь, ДО цикла
    // исполнения черновиков ниже, а await — только непосредственно перед
    // созданием assistant-сообщения (нужен её id для replyToMessageId): это
    // сохраняет часть выигрыша исходного fire-and-forget (запись идёт
    // параллельно с executeTaskAction/executeEventAction), при этом ответ
    // пользователю теперь ДОЛЖЕН содержать реальный userMessage/
    // assistantMessage (следующий Phase H-экран рендерит голосовую реплику
    // тем же MessagePartRenderer, что и текст) — полностью fire-and-forget,
    // как раньше, здесь уже не получится.
    const userMessagePromise = this.prisma.message
      .create({
        data: {
          conversationId: conversation.id,
          role: MessageRole.USER,
          status: MessageStatus.COMPLETED,
          clientRequestId,
          parts: { create: [{ type: MessagePartType.MARKDOWN, order: 0, data: { content: transcript } }] },
        },
        include: { parts: { orderBy: { order: 'asc' } } },
      })
      .catch(async (err) => {
        // Гонка (Stage 2, Phase H.1) — теоретический defense-in-depth: сам
        // durable claim (VoiceExecution, см. claimAndRunDurable) уже не
        // должен пропускать сюда два одновременных вызова с одним
        // clientRequestId, но на случай прямого P2002 здесь всё равно
        // безопасно восстановиться, не падать 500-й. Тот же приём, что уже
        // в AssistantChatService.createUserMessageIdempotent.
        if (isUniqueConstraintError(err)) {
          const winner = await this.prisma.message.findUnique({
            where: { conversationId_clientRequestId: { conversationId: conversation.id, clientRequestId } },
            include: { parts: { orderBy: { order: 'asc' } } },
          });
          if (winner) return winner;
        }
        throw err;
      });

    const taskIds = new Set(taskContext.map((t) => t.id));
    const eventIds = new Set(eventContext.map((e) => e.id));
    const employeeIds = new Set(employees.map((e) => e.id));

    // Один транскрипт — несколько самостоятельных команд (владелец
    // 10.09.2026, найдено в проде: "удали встречу с Петром и создай новую
    // на пятницу" в одной аудиозаписи — агент удалил встречу, а создание
    // потерялось, потому что раньше схема инструмента физически могла
    // вернуть только одно действие за раз). Каждый элемент result.drafts
    // проходит ту же цепочку валидации независимо; flatMap — потому что
    // enforceEventRbac может РАЗВЕРНУТЬ один элемент в два (даунгрейд
    // событие→задача + отдельное чат-объяснение), см. её комментарий.
    //
    // slice(0, MAX_DRAFTS_PER_NOTE) — потолок задать в самой схеме нельзя
    // (см. комментарий у MAX_DRAFTS_PER_NOTE в draft-extraction.service.ts),
    // защита от патологического транскрипта здесь, постфактум.
    //
    // Promise.all + flat() вместо синхронного flatMap (Stage 2, Phase I) —
    // resolveAssigneeMention ниже асинхронный (обращается к
    // EmployeeAlias в БД), остальные шаги синхронные и порядок между собой
    // не меняли.
    const draftGroups = await Promise.all(
      result.drafts.slice(0, MAX_DRAFTS_PER_NOTE).map(async (draft) => {
        const validatedTarget = this.validateTarget(draft, taskIds, eventIds);
        const withCompleteEvent = this.validateEventCreateCompleteness(validatedTarget);
        const validatedRefs = this.validateReferences(withCompleteEvent, employeeIds);
        const resolvedAssignee = await this.resolveAssigneeMention(validatedRefs, employees);
        const enrichedDraft = this.attachAssigneeName(resolvedAssignee, employees);
        const withMeeting = this.attachSourceMeeting(enrichedDraft, meetingId, meetingContext);
        return this.enforceEventRbac(withMeeting, user.role);
      }),
    );
    const drafts = draftGroups.flat();

    // Без minItems в схеме (Anthropic его тоже не поддерживает, см. тот же
    // комментарий) пустой drafts теоретически возможен — без этой защиты
    // пользователь получил бы полную тишину в чате вместо какого-либо ответа.
    if (drafts.length === 0) {
      drafts.push({ type: 'chat', reply: 'Не расслышал — повторите, пожалуйста.' });
    }

    // Выполняем каждый черновик (владелец 10.09.2026, аудит п. 2.11) — не
    // возвращаем черновики фронтенду на отдельный POST/PATCH/DELETE, а
    // сразу мутируем здесь, в том же запросе. Последовательно, не
    // Promise.all: порядок имеет значение (например, "удали встречу с
    // Петром и создай новую на пятницу" — два действия над разными
    // записями, но естественно выполнить их в порядке произнесения), и
    // executeTaskAction/executeEventAction сами ловят свои ошибки — сбой
    // одного действия не должен прерывать остальные в этом же транскрипте.
    // EXECUTING (Stage 2, Phase H.3) — с этого момента retry небезопасен:
    // executeTaskAction/executeEventAction ниже реально мутируют Task/Event.
    // Если сам цикл упадёт непредвиденно (сами методы ловят свои ошибки —
    // это был бы баг где-то ещё, не обычный business error), неизвестно,
    // сколько действий из drafts успело выполниться — не FAILED (это
    // разрешило бы retry и повторную мутацию УЖЕ выполненных действий), а
    // NEEDS_RECONCILIATION: claimAndRunDurable откажет в повторе, оставляя
    // ручную проверку по логам/audit trail.
    await this.prisma.voiceExecution
      .update({ where: { id: executionId }, data: { status: VoiceExecutionStatus.EXECUTING } })
      .catch(() => {});

    const t2 = Date.now();
    const execResults: ExecutedVoiceAction[] = [];
    try {
      for (const draft of drafts) {
        if (draft.type === 'chat') {
          execResults.push({ result: { type: 'chat', reply: stripLeakedContextMarkers(draft.reply) }, entity: null });
        } else if (draft.type === 'task_action') {
          execResults.push(await this.executeTaskAction(draft, user));
        } else {
          execResults.push(await this.executeEventAction(draft, user));
        }
      }
    } catch (err) {
      await this.prisma.voiceExecution
        .update({ where: { id: executionId }, data: { status: VoiceExecutionStatus.NEEDS_RECONCILIATION, errorMessage: toErrorMessage(err) } })
        .catch(() => {});
      throw err;
    }
    const results: VoiceActionResult[] = execResults.map((r) => r.result);
    const executionMs = Date.now() - t2;

    // Ответ ассистента (Stage 2, Phase H) — один Message с одной частью на
    // каждый execResults[i] (см. buildVoiceAssistantParts), в общей ленте
    // сотрудника. clarificationReason — общая оценка на весь транскрипт, не
    // на конкретное действие, отдельной частью последней. resolveClarificationReason
    // (voice-render.ts) — гейт на clarificationNeeded + санитизация от утечки
    // [shown_task]/[file]-меток в одном месте, см. комментарий там (живой
    // прогон 20.09.2026 поймал лишний пузырь "null" без этого гейта).
    const clarificationReason = resolveClarificationReason(result.clarificationNeeded, result.clarificationReason);

    // COMPLETED (Stage 2, Phase H.3) — ставим СРАЗУ здесь, а не после
    // персистентности ниже: действия выше уже выполнены и это необратимо,
    // и именно этот факт (а не то, сохранилась ли история переписки)
    // должен решать, безопасен ли retry (см. claimAndRunDurable и
    // комментарий у try/catch персистентности ниже про Phase H.1).
    // resultJson хранит ВЕСЬ ответ (включая реальные results — taskId/
    // previous и т.п.), не пустышку: retry на COMPLETED теперь получает
    // настоящий исход, а не "results: []", как было в старом
    // findCachedParseResponse.
    await this.prisma.voiceExecution
      .update({
        where: { id: executionId },
        data: {
          status: VoiceExecutionStatus.COMPLETED,
          resultJson: toJson({ transcript, confidence: result.confidence, clarificationNeeded: result.clarificationNeeded, clarificationReason, results }),
        },
      })
      .catch(() => {});

    // Stage 2, Phase H.1 (внешний аудит 20.09.2026, P1) — действия выше
    // (executeTaskAction/executeEventAction) УЖЕ выполнены к этому моменту.
    // Раньше `await userMessagePromise` без try/catch означал, что сбой
    // ЗДЕСЬ (сохранение истории переписки) валил весь запрос 500-й
    // ошибкой, хотя реальная мутация уже случилась и никуда не делась —
    // пользователь видел "не удалось", хотя задача/событие уже
    // созданы/изменены/удалены. Теперь сбой персистентности не выдаёт себя
    // за отменённое действие: results (реальный исход) уходят клиенту как
    // обычно, userMessage/assistantMessage — null (фронтенд просто не
    // добавляет голосовую реплику в общую ленту в этом редком случае),
    // сбой явно и подробно логируется — диагностируем, не тонет молча в
    // общем 500.
    const t3 = Date.now();
    let userMessage: MessageWithParts | null = null;
    let assistantMessage: MessageWithParts | null = null;
    try {
      userMessage = await userMessagePromise;
      assistantMessage = await this.prisma.message.create({
        data: {
          conversationId: conversation.id,
          role: MessageRole.ASSISTANT,
          status: MessageStatus.COMPLETED,
          replyToMessageId: userMessage.id,
          parts: { create: buildVoiceAssistantParts(execResults, clarificationReason) },
        },
        include: { parts: { orderBy: { order: 'asc' } } },
      });
      await this.prisma.conversation.update({ where: { id: conversation.id }, data: { updatedAt: new Date() } });
      await this.prisma.voiceExecution
        .update({ where: { id: executionId }, data: { userMessageId: userMessage.id, assistantMessageId: assistantMessage.id } })
        .catch(() => {});
    } catch (err) {
      this.logger.error(
        `voice parse reqId=${requestId} persistence failed AFTER actions already executed ` +
          `(draftsCount=${drafts.length}, outcomes=${results.map((r) => (r.type === 'chat' ? 'chat' : r.ok ? 'ok' : 'error')).join(',')}): ` +
          `${err instanceof Error ? err.message : err}`,
      );
    }
    // Stage 2, Phase H.1 (внешний аудит 20.09.2026, P2, observability) —
    // раньше totalMs считался ДО await userMessagePromise/создания
    // assistantMessage/обновления conversation, хотя ответ клиенту ждёт
    // именно их — метрика занижала реальное время до HTTP-ответа.
    // persistenceMs — отдельно, чтобы разделить "сколько заняли реальные
    // действия" (executionMs) от "сколько заняло сохранение истории".
    const persistenceMs = Date.now() - t3;
    const totalMs = Date.now() - t0;

    // Единая сводная строка на весь voice request (observability-этап,
    // владелец 15.09.2026, раздел 2-3 ТЗ этапа) — reqId тот же, что в
    // логе draft-extraction выше, оба грепаются вместе одним id. Только
    // технические метрики: транскрипт/контент чата сюда намеренно не
    // попадают (раздел 3 ТЗ этапа — запрет на transcript/raw audio/секреты
    // в performance-логах).
    this.logger.log(
      `voice parse reqId=${requestId} audioBytes=${audioBytes} audioDurationMs=${audioDurationMs ?? 'n/a'} ` +
        `sttMs=${sttMs} contextDbMs=${contextDbMs} llmFastMs=${result.timing.fastMs} ` +
        `llmStrongMs=${result.timing.strongMs} escalatedToStrongModel=${result.escalatedToStrongModel} ` +
        `executionMs=${executionMs} persistenceMs=${persistenceMs} totalMs=${totalMs} draftsCount=${drafts.length}`,
    );

    // Раздел 15 ТЗ: голосовые заметки — чувствительный контент. Логируем сам
    // факт транскрибации/разбора и её исход, не текст транскрипта.
    // entityId = requestId (не отдельный randomUUID()) — черновик эфемерный,
    // своего id в БД у него нет, но теперь запись аудита ищется по тому же
    // id, что и лог-строки этого запроса (observability-этап, 15.09.2026).
    // Не await (владелец 10.09.2026, по итогам анализа задержки) — запись
    // аудита не должна задерживать ответ пользователю; AuditService.log
    // сама глотает свои ошибки (см. её комментарий), не нужно перехватывать
    // их здесь ещё раз.
    void this.audit.log(user.id, 'TRANSCRIBE', 'VoiceDraft', requestId, {
      draftTypes: drafts.map((d) => d.type),
      outcomes: results.map((r) => (r.type === 'chat' ? 'chat' : r.ok ? 'ok' : 'error')),
      confidence: result.confidence,
    });

    return {
      transcript,
      confidence: result.confidence,
      clarificationNeeded: result.clarificationNeeded,
      clarificationReason,
      results,
      conversationId: userMessage ? conversation.id : null,
      userMessage: userMessage ? toResponseMessage(userMessage) : null,
      assistantMessage: assistantMessage ? toResponseMessage(assistantMessage) : null,
    };
  }

  // Trusted server-side undo (Stage 2, Phase H.4, внешний аудит
  // 21.09.2026) — создаётся сразу после мутации (create/update), хранит
  // снимок "до" (previous) и/или инвертируемые списки участников на
  // сервере; клиенту отдаётся только id этой записи (undoToken, см.
  // VoiceTaskActionResult/VoiceEventActionResult) — сам откат в undo()
  // ниже читает данные отсюда, не из того, что прислал клиент.
  // Stage 2, Phase L (внешний аудит 21.09.2026, P0/P1 — "business mutation
  // не должна зависеть от UndoRecord") — раньше вызывающий код (executeTaskAction/
  // executeEventAction) делал `await this.createUndoRecord(...)` внутри ТОГО ЖЕ
  // try, что и саму мутацию: сбой здесь (например, БД недоступна на долю
  // секунды) означал, что УЖЕ СОЗДАННАЯ/ИЗМЕНЁННАЯ задача/событие репортились
  // клиенту как ok:false — пользователь повторял команду и получал дубликат.
  // undo — вторичное удобство, не основной результат действия; эта функция
  // теперь сама ловит свою ошибку и возвращает null вместо того, чтобы
  // прокидывать её вызывающему коду.
  private async createUndoRecord(
    user: AuthenticatedUser,
    kind: UndoKind,
    action: UndoRecordAction,
    entityId: string,
    extra: { previous?: unknown; addedParticipantIds?: string[]; removedParticipantIds?: string[] } = {},
  ): Promise<string | null> {
    try {
      const record = await this.prisma.undoRecord.create({
        data: {
          employeeId: user.id,
          kind,
          action,
          entityId,
          previous: extra.previous !== undefined ? toJson(extra.previous) : undefined,
          addedParticipantIds: extra.addedParticipantIds ? toJson(extra.addedParticipantIds) : undefined,
          removedParticipantIds: extra.removedParticipantIds ? toJson(extra.removedParticipantIds) : undefined,
          status: UndoRecordStatus.AVAILABLE,
          expiresAt: new Date(Date.now() + UNDO_WINDOW_MS),
        },
      });
      return record.id;
    } catch (err) {
      this.logger.error(
        `createUndoRecord failed for ${kind}/${action}/${entityId} — действие УЖЕ выполнено, продолжаем без undo: ${err instanceof Error ? err.message : err}`,
      );
      return null;
    }
  }

  // Создаёт/обновляет/удаляет задачу напрямую через TasksService (та же
  // RBAC-проверка, что у обычного PATCH/DELETE /tasks/:id — не дублируем
  // её здесь) и возвращает итог вместо черновика. undoToken — см.
  // createUndoRecord выше; null для delete (сущности уже нет, откатывать
  // нечего) и для ok=false.
  private async executeTaskAction(draft: VoiceTaskActionDraft, user: AuthenticatedUser): Promise<ExecutedVoiceAction> {
    try {
      if (draft.action === 'create') {
        const dto: CreateTaskDto = {
          title: draft.title,
          description: draft.description || undefined,
          assigneeId: draft.assigneeId || undefined,
          priority: draft.priority || undefined,
          dueDate: draft.dueDate || undefined,
          sourceMeetingId: draft.sourceMeetingId || undefined,
        };
        const created = await this.tasks.create(dto, user);
        const undoToken = await this.createUndoRecord(user, UndoKind.TASK, UndoRecordAction.CREATE, created.id);
        return {
          result: { type: 'task_action', draft, ok: true, error: null, taskId: created.id, undoToken },
          entity: created,
        };
      }

      if (draft.action === 'update') {
        // UpdateTaskDto — уже PartialType(...), все поля опциональны сами
        // по себе, отдельный Partial<CreateTaskDto> + "as" не нужен.
        const dto: UpdateTaskDto = {};
        if (draft.title !== '') dto.title = draft.title;
        if (draft.description !== '') dto.description = draft.description;
        if (draft.assigneeId !== null) dto.assigneeId = draft.assigneeId;
        if (draft.dueDate !== null) dto.dueDate = draft.dueDate;
        if (draft.priority !== null) dto.priority = draft.priority;

        // Снимок ДО патча — единственный способ узнать старые значения,
        // черновик их не несёт.
        const before = await this.tasks.findOne(draft.targetTaskId, user);
        const previous: TaskRevertPayload = {};
        if (dto.title !== undefined) previous.title = before.title;
        if (dto.description !== undefined) previous.description = before.description ?? '';
        if (dto.assigneeId !== undefined) previous.assigneeId = before.assignee?.id ?? null;
        // before.dueDate — сырой Prisma Date (findOne вызван напрямую, не
        // через HTTP — сериализация в строку, которую видит фронтенд
        // обычно, происходит только на выходе из Nest-контроллера).
        if (dto.dueDate !== undefined) previous.dueDate = before.dueDate ? before.dueDate.toISOString() : null;
        if (dto.priority !== undefined) previous.priority = before.priority;

        // updated — свежая сущность ПОСЛЕ патча (Stage 2, Phase H): раньше
        // возврат update() отбрасывался, карточку в объединённой ленте
        // строить было не из чего.
        const updated = await this.tasks.update(draft.targetTaskId, dto, user);
        const undoToken = await this.createUndoRecord(user, UndoKind.TASK, UndoRecordAction.UPDATE, draft.targetTaskId, { previous });
        return {
          result: { type: 'task_action', draft, ok: true, error: null, taskId: draft.targetTaskId, undoToken },
          entity: updated,
        };
      }

      // delete — без дополнительного подтверждения (владелец 10.09.2026:
      // "по удалению давай доверять", после практической проверки).
      await this.tasks.remove(draft.targetTaskId, user);
      return {
        result: { type: 'task_action', draft, ok: true, error: null, taskId: draft.targetTaskId, undoToken: null },
        entity: null,
      };
    } catch (err) {
      return {
        result: { type: 'task_action', draft, ok: false, error: toErrorMessage(err), taskId: null, undoToken: null },
        entity: null,
      };
    }
  }

  // Аналог executeTaskAction для событий — EventsService.create/update/
  // remove/addParticipant/removeParticipant принимают employeeId, не весь
  // AuthenticatedUser (весь модуль и так закрыт на Role.OWNER на уровне
  // контроллера, см. комментарий в events.service.ts); enforceEventRbac
  // выше гарантирует, что сюда event_action от не-OWNER не попадает.
  private async executeEventAction(draft: VoiceEventActionDraft, user: AuthenticatedUser): Promise<ExecutedVoiceAction> {
    try {
      if (draft.action === 'create') {
        const dto: CreateEventDto = {
          title: draft.title,
          description: draft.description || undefined,
          location: draft.location || undefined,
          startAt: draft.startAt ?? '',
          endAt: draft.endAt ?? '',
          allDay: draft.allDay ?? false,
        };
        const created = await this.events.create(dto, user.id);
        for (const employeeId of draft.addParticipantIds) {
          await this.events.addParticipant(created.id, employeeId).catch(() => {});
        }
        // Свежая сущность ПОСЛЕ добавления участников (Stage 2, Phase H) —
        // created сам по себе ещё не знает про них (addParticipant меняет
        // строку в БД уже после того, как created был получен), карточка с
        // пустым participants была бы неверна для только что созданной
        // встречи с указанными участниками.
        const entity = draft.addParticipantIds.length > 0 ? await this.events.findOne(created.id) : created;
        const undoToken = await this.createUndoRecord(user, UndoKind.EVENT, UndoRecordAction.CREATE, created.id);
        return {
          result: { type: 'event_action', draft, ok: true, error: null, eventId: created.id, undoToken },
          entity,
        };
      }

      if (draft.action === 'update') {
        // UpdateEventDto — уже PartialType(CreateEventDto), отдельный
        // Partial<CreateEventDto> + "as" не нужен.
        const dto: UpdateEventDto = {};
        if (draft.title !== '') dto.title = draft.title;
        if (draft.description !== '') dto.description = draft.description;
        if (draft.location !== '') dto.location = draft.location;
        if (draft.startAt !== null) dto.startAt = draft.startAt;
        if (draft.endAt !== null) dto.endAt = draft.endAt;
        if (draft.allDay !== null) dto.allDay = draft.allDay;

        const previous: EventRevertPayload = {};
        if (Object.keys(dto).length > 0) {
          const before = await this.events.findOne(draft.targetEventId);
          if (dto.title !== undefined) previous.title = before.title;
          if (dto.description !== undefined) previous.description = before.description ?? '';
          if (dto.location !== undefined) previous.location = before.location ?? '';
          if (dto.startAt !== undefined) previous.startAt = before.startAt.toISOString();
          if (dto.endAt !== undefined) previous.endAt = before.endAt.toISOString();
          if (dto.allDay !== undefined) previous.allDay = before.allDay;
          await this.events.update(draft.targetEventId, dto, user.id);
        }
        for (const employeeId of draft.addParticipantIds) {
          await this.events.addParticipant(draft.targetEventId, employeeId).catch(() => {});
        }
        for (const employeeId of draft.removeParticipantIds) {
          await this.events.removeParticipant(draft.targetEventId, employeeId).catch(() => {});
        }
        // Один финальный findOne после всех изменений (полей + участников)
        // — Stage 2, Phase H: раньше возврат update()/addParticipant не
        // использовался вовсе, строить карточку было не из чего.
        const entity = await this.events.findOne(draft.targetEventId);
        const undoToken = await this.createUndoRecord(user, UndoKind.EVENT, UndoRecordAction.UPDATE, draft.targetEventId, {
          previous,
          addedParticipantIds: draft.addParticipantIds,
          removedParticipantIds: draft.removeParticipantIds,
        });
        return {
          result: { type: 'event_action', draft, ok: true, error: null, eventId: draft.targetEventId, undoToken },
          entity,
        };
      }

      // delete — без дополнительного подтверждения, тот же принцип, что и
      // для задач (владелец 10.09.2026).
      await this.events.remove(draft.targetEventId, user.id);
      return {
        result: { type: 'event_action', draft, ok: true, error: null, eventId: draft.targetEventId, undoToken: null },
        entity: null,
      };
    } catch (err) {
      return {
        result: { type: 'event_action', draft, ok: false, error: toErrorMessage(err), eventId: null, undoToken: null },
        entity: null,
      };
    }
  }

  // Последние реплики этого пользователя, в хронологическом порядке, в
  // пределах окна VOICE_HISTORY_MAX_AGE_MS — см. комментарий у констант
  // выше. findMany с take по индексу [employeeId, createdAt] дёшев
  // независимо от того, сколько всего реплик накопилось за всё время.
  // Stage 2, Phase H — читает ту же ленту (Message/MessagePart), что и
  // текстовый чат, вместо отдельной VoiceMessage. conversationId, а не
  // employeeId — разговор уже resolved в parse() (getOrCreatePrimaryConversation),
  // не нужно резолвить его второй раз через relation-фильтр.
  // serializeMessageForModelContext — тот же сериализатор, что уже
  // используется AssistantChatService.loadHistory (Stage 2, Phase F.1), даёт
  // тот же {role, text}-формат, что уже ожидает DraftExtractionService (не
  // меняется).
  private async loadHistory(conversationId: string): Promise<VoiceHistoryItem[]> {
    const rows = await this.prisma.message.findMany({
      where: { conversationId, createdAt: { gte: new Date(Date.now() - VOICE_HISTORY_MAX_AGE_MS) } },
      orderBy: { createdAt: 'desc' },
      take: VOICE_HISTORY_LIMIT,
      include: { parts: { orderBy: { order: 'asc' } } },
    });
    return rows
      .reverse()
      .map((m) => ({
        role: m.role === MessageRole.USER ? ('user' as const) : ('assistant' as const),
        text: serializeMessageForModelContext(m.parts),
      }))
      .filter((h) => h.text);
  }

  // Отдельное ("standalone") assistant-сообщение без replyToMessageId (ни
  // на какое user-сообщение не отвечает) в общей ленте — сейчас единственный
  // вызывающий это undo() ниже. Stage 2, Phase H.1 (аудит 20.09.2026,
  // P0/P1) — раньше был отдельным публичным эндпоинтом POST /voice/messages
  // с произвольным текстом от клиента (conversation-history poisoning —
  // см. комментарий у VoiceUndoDto); текст теперь всегда решает сервер, не
  // клиент, поэтому метод стал private.
  private async logAssistantMessage(text: string, user: AuthenticatedUser): Promise<void> {
    const conversation = await this.assistantChat.getOrCreatePrimaryConversation(user);
    await this.prisma.message.create({
      data: {
        conversationId: conversation.id,
        role: MessageRole.ASSISTANT,
        status: MessageStatus.COMPLETED,
        parts: { create: [{ type: MessagePartType.MARKDOWN, order: 0, data: { content: text } }] },
      },
    });
  }

  // POST /voice/undo (Stage 2, Phase H.1 → H.4) — заменяет прежний паттерн
  // "фронтенд сам откатывает через PATCH/DELETE, потом просит сервер
  // записать придуманный текст" (POST /voice/messages). Phase H.4 (внешний
  // аудит 21.09.2026, "trusted server-side undo") пошла дальше: раньше
  // dto нёс authoritative previous/addedParticipantIds/removedParticipantIds
  // от клиента — устаревший/подделанный payload мог откатить сущность в
  // состояние, которого никогда не было. Теперь dto — только undoToken
  // (id UndoRecord, который сервер сам создал и сохранил сразу после
  // мутации, см. createUndoRecord/executeTaskAction/executeEventAction) —
  // клиент больше не authoritative источник отката.
  //
  // Один общий безопасный текст на "не найдено"/"чужое"/"уже
  // отменено"/"истекло" — тот же принцип "не раскрываем, какой из
  // случаев", что и у 404 при скачивании чужого файла (FilesService).
  // Stage 2, Phase L (внешний аудит 21.09.2026, "Undo consistency", P1) —
  // раньше "занято" (consumedAt) ставилось СРАЗУ при claim'е, ДО попытки
  // самого отката — если сам откат падал (TasksService.update и т.п.
  // бросали), запись оставалась помеченной использованной НАВСЕГДА, и
  // повторный клик "Отменить" получал generic-отказ, хотя откат так и не
  // произошёл. Теперь статус — явный конечный автомат: AVAILABLE →
  // CLAIMED (атомарно, тот же приём P2025 через where) → COMPLETED (откат
  // реально удался) или обратно в AVAILABLE (откат упал — в пределах
  // expiresAt пользователь может нажать "Отменить" ещё раз).
  async undo(dto: VoiceUndoDto, user: AuthenticatedUser): Promise<{ ok: boolean; error: string | null }> {
    const genericError = 'Время для отмены истекло, действие уже отменено, или ссылка на отмену недействительна.';
    const record = await this.prisma.undoRecord.findUnique({ where: { id: dto.undoToken } });
    if (!record || record.employeeId !== user.id || record.expiresAt.getTime() < Date.now()) {
      await this.logAssistantMessage(`Не получилось отменить: ${genericError}`, user).catch(() => {});
      return { ok: false, error: genericError };
    }

    // Защитная проверка роли — та же RBAC-проверка, не задвоена:
    // TasksService.update/remove сами проверяют постановщика/руководителя,
    // EventsService — по факту, что модуль целиком закрыт на OWNER.
    // Кнопка "Отменить" для события в принципе не показывается не-OWNER на
    // фронте, но это не граница безопасности сама по себе (тот же принцип,
    // что и у enforceEventRbac).
    if (record.kind === UndoKind.EVENT && user.role !== Role.OWNER) {
      const error = 'Календарь доступен только руководителю — отменить это действие может только он.';
      await this.logAssistantMessage(`Не получилось отменить: ${error}`, user).catch(() => {});
      return { ok: false, error };
    }

    // Атомарный claim — where: {id, status: AVAILABLE} закрывает узкую
    // гонку двойного одновременного POST /voice/undo с одним undoToken:
    // если конкурентный запрос уже успел перевести статус между findUnique
    // выше и этим update, where больше не matches ни одной строки, Prisma
    // бросает P2025 вместо того, чтобы молча обновить нулём строк — этот
    // запрос откатывается на безопасный "уже отменено", не выполняет
    // мутацию повторно.
    try {
      await this.prisma.undoRecord.update({ where: { id: record.id, status: UndoRecordStatus.AVAILABLE }, data: { status: UndoRecordStatus.CLAIMED } });
    } catch (err) {
      if (isRecordNotFoundError(err)) {
        return { ok: false, error: genericError };
      }
      throw err;
    }

    try {
      if (record.kind === UndoKind.TASK) {
        if (record.action === UndoRecordAction.CREATE) {
          await this.tasks.remove(record.entityId, user);
        } else {
          const previous = (record.previous ?? {}) as TaskRevertPayload;
          const patch: UpdateTaskDto = {};
          if (previous.title !== undefined) patch.title = previous.title;
          if (previous.description !== undefined) patch.description = previous.description;
          if (previous.assigneeId !== undefined) patch.assigneeId = previous.assigneeId;
          if (previous.dueDate !== undefined) patch.dueDate = previous.dueDate;
          if (previous.priority !== undefined) patch.priority = previous.priority;
          await this.tasks.update(record.entityId, patch, user);
        }
      } else {
        if (record.action === UndoRecordAction.CREATE) {
          await this.events.remove(record.entityId, user.id);
        } else {
          const previous = (record.previous ?? {}) as EventRevertPayload;
          const patch: UpdateEventDto = {};
          if (previous.title !== undefined) patch.title = previous.title;
          if (previous.description !== undefined) patch.description = previous.description;
          if (previous.location !== undefined) patch.location = previous.location;
          if (previous.startAt !== undefined) patch.startAt = previous.startAt;
          if (previous.endAt !== undefined) patch.endAt = previous.endAt;
          if (previous.allDay !== undefined) patch.allDay = previous.allDay;
          if (Object.keys(patch).length > 0) await this.events.update(record.entityId, patch, user.id);
          // Инверсия: то, что исходное действие ДОБАВИЛО, undo СНИМАЕТ, и
          // наоборот — тот же смысл, что уже был в прежнем клиентском
          // performUndo (обеих фронтендов), просто выполняется здесь.
          const addedParticipantIds = (record.addedParticipantIds ?? []) as string[];
          const removedParticipantIds = (record.removedParticipantIds ?? []) as string[];
          for (const employeeId of addedParticipantIds) {
            await this.events.removeParticipant(record.entityId, employeeId).catch(() => {});
          }
          for (const employeeId of removedParticipantIds) {
            await this.events.addParticipant(record.entityId, employeeId).catch(() => {});
          }
        }
      }
      await this.prisma.undoRecord.update({ where: { id: record.id }, data: { status: UndoRecordStatus.COMPLETED, consumedAt: new Date() } });
      // Логирование подтверждения — вторичный эффект, не должен превращать
      // уже случившийся успешный откат в ok:false для клиента (тот же
      // принцип, что и graceful degradation в runParse, Phase H.1).
      await this.logAssistantMessage('Отменено.', user).catch(() => {});
      return { ok: true, error: null };
    } catch (err) {
      const error = toErrorMessage(err);
      // Откат не удался — возвращаем запись в AVAILABLE (best-effort, в
      // своём catch: сбой этого шага не должен маскировать реальную
      // причину сбоя отката), чтобы пользователь мог нажать "Отменить" ещё
      // раз в пределах expiresAt, а не получал "уже отменено" на ровном месте.
      await this.prisma.undoRecord.update({ where: { id: record.id }, data: { status: UndoRecordStatus.AVAILABLE } }).catch(() => {});
      await this.logAssistantMessage(`Не получилось отменить: ${error}`, user).catch(() => {});
      return { ok: false, error };
    }
  }

  // id-поля в схеме инструмента больше не enum (см. комментарий у
  // NULLABLE_ID в draft-extraction.service.ts) — targetTaskId/targetEventId,
  // если не входят в реально показанный Claude список, превращают черновик
  // в chat с объяснением, а не 404 где-то ниже по цепочке; невалидные
  // ассignee/участники просто отфильтровываются (fail-safe в "без
  // исполнителя/без этого участника", а не в ошибку).
  private validateTarget(draft: VoiceDraft, taskIds: Set<string>, eventIds: Set<string>): VoiceDraft {
    if (draft.type === 'task_action' && draft.action !== 'create' && !taskIds.has(draft.targetTaskId)) {
      return { type: 'chat', reply: `Не нашёл задачу «${draft.targetTitle}» — уточните, пожалуйста, формулировку.` };
    }
    if (draft.type === 'event_action' && draft.action !== 'create' && !eventIds.has(draft.targetEventId)) {
      return { type: 'chat', reply: `Не нашёл встречу «${draft.targetTitle}» — уточните, пожалуйста, формулировку.` };
    }
    return draft;
  }

  // Владелец 10.09.2026, найдено в проде: если время начала вообще не
  // названо при создании события, normalizeDraftDates (см.
  // draft-extraction.service.ts) не может подставить разумный endAt (нечего
  // прибавлять час к), и POST /events упал бы валидацией на пустом startAt.
  // Промпт теперь просит выбрать "chat" в этом случае, но это не граница —
  // подстраховываемся здесь: недостающее startAt на create превращаем в
  // уточняющий вопрос вместо попытки создать битое событие.
  private validateEventCreateCompleteness(draft: VoiceDraft): VoiceDraft {
    if (draft.type === 'event_action' && draft.action === 'create' && !draft.startAt) {
      return {
        type: 'chat',
        reply: `Не расслышал, на какое время поставить встречу «${draft.title || 'без названия'}» — уточните дату и время.`,
      };
    }
    return draft;
  }

  private validateReferences(draft: VoiceDraft, employeeIds: Set<string>): VoiceDraft {
    const validId = (id: string | null) => (id && employeeIds.has(id) ? id : null);
    const validIds = (ids: string[]) => ids.filter((id) => employeeIds.has(id));

    if (draft.type === 'task_action') {
      return { ...draft, assigneeId: validId(draft.assigneeId) };
    }
    if (draft.type === 'event_action') {
      return {
        ...draft,
        addParticipantIds: validIds(draft.addParticipantIds),
        removeParticipantIds: validIds(draft.removeParticipantIds),
      };
    }
    return draft;
  }

  // Stage 2, Phase I (внешний аудит 21.09.2026, "Employee Resolver") —
  // независимая от модели перепроверка assigneeId. Раньше assigneeId,
  // предложенный моделью, либо принимался как есть, либо (если модель
  // ошиблась/сослалась на несуществующий id) validateReferences выше
  // тихо превращал его в null — задача создавалась БЕЗ исполнителя, хотя
  // пользователь явно назвал имя ("Поставь Амиру задачу..."). Теперь при
  // assigneeMentioned=true сервер сам ищет сотрудника по буквальному
  // тексту (assigneeRawText) через EmployeeResolverService — RESOLVED
  // переопределяет assigneeId результатом резолвера (доверяем ему больше,
  // чем изначальной догадке модели, поскольку резолвер детерминированно
  // проверяет по реальному списку алиасов/имён, а не угадывает по
  // контексту); AMBIGUOUS/NOT_FOUND превращают черновик в уточняющий
  // вопрос вместо того, чтобы молча создать/изменить задачу без
  // исполнителя или с неверным.
  private async resolveAssigneeMention(draft: VoiceDraft, employees: { id: string; fullName: string }[]): Promise<VoiceDraft> {
    if (draft.type !== 'task_action' || !draft.assigneeMentioned || !draft.assigneeRawText) {
      return draft;
    }
    const resolution = await this.employeeResolver.resolve(draft.assigneeRawText, employees);
    if (resolution.status === 'RESOLVED') {
      return { ...draft, assigneeId: resolution.employeeId };
    }
    const question =
      resolution.status === 'AMBIGUOUS'
        ? `Уточните, пожалуйста, кого вы имели в виду под «${draft.assigneeRawText}» — нашлось несколько похожих сотрудников.`
        : `Не нашёл сотрудника «${draft.assigneeRawText}» среди видимых вам — уточните, пожалуйста, имя.`;
    return { type: 'chat', reply: question };
  }

  // assigneeId/addParticipantIds/removeParticipantIds на этом этапе уже
  // проверены (validateReferences выше) — имена резолвим здесь, из того же
  // списка сотрудников, чтобы фронтенду не нужен был отдельный запрос к
  // /employees ради текста чат-подтверждения.
  private attachAssigneeName(draft: VoiceDraft, employees: { id: string; fullName: string }[]): VoiceDraft {
    const nameOf = (id: string) => employees.find((e) => e.id === id)?.fullName ?? '';

    if (draft.type === 'task_action') {
      return { ...draft, assigneeName: draft.assigneeId ? (nameOf(draft.assigneeId) || null) : null };
    }
    if (draft.type === 'event_action') {
      return {
        ...draft,
        addParticipantNames: draft.addParticipantIds.map(nameOf),
        removeParticipantNames: draft.removeParticipantIds.map(nameOf),
      };
    }
    return draft;
  }

  // sourceMeetingId — не поле схемы инструмента Claude (см.
  // draft-extraction.service.ts), проставляем сами: диктовка со страницы
  // встречи получает ссылку на неё, чтобы исполнитель понимал контекст
  // (владелец 09.09.2026). Только для action='create' — редактирование/
  // удаление уже существующей задачи не должно задним числом менять её
  // происхождение. meetingContext уже null, если запись не найдена или
  // пользователь не OWNER — не валидный meetingId сюда просто не дойдёт.
  private attachSourceMeeting(
    draft: VoiceDraft,
    meetingId: string | undefined,
    meetingContext: unknown,
  ): VoiceDraft {
    if (draft.type !== 'task_action' || draft.action !== 'create') return draft;
    return { ...draft, sourceMeetingId: meetingContext && meetingId ? meetingId : null };
  }

  // Claude инструктирован никогда не классифицировать транскрипт не-OWNER'а
  // как событие, но промпт — не граница безопасности (голосовой ввод
  // пользователя — canonical prompt-injection surface). Реальная граница —
  // здесь: /events закрыт на Role.OWNER (см. CalendarController), поэтому
  // черновик события от кого угодно другого принудительно превращается в
  // черновик задачи (create) или в chat (update/delete — редактировать
  // чужой недоступный календарь всё равно нечем).
  //
  // Возвращает массив (владелец 10.09.2026, переход на drafts: VoiceDraft[]
  // в parse() выше): даунгрейд create→task_action теряет возможность
  // объяснить, ПОЧЕМУ вместо встречи создалась задача (у task_action нет
  // поля reply) — раньше это объяснение шло отдельным полем
  // clarificationReason на весь ответ целиком, что не масштабируется на
  // несколько независимых черновиков в одном транскрипте. Теперь вместо
  // этого — второй элемент массива: тот же task_action, плюс отдельная
  // chat-реплика с объяснением сразу следом.
  private enforceEventRbac(draft: VoiceDraft, role: Role): VoiceDraft[] {
    if (role === Role.OWNER || draft.type !== 'event_action') return [draft];

    if (draft.action === 'create') {
      const taskDraft: VoiceDraft = {
        type: 'task_action',
        action: 'create',
        targetTaskId: '',
        targetTitle: draft.title,
        title: draft.title,
        description: draft.description,
        assigneeId: null,
        assigneeName: null,
        assigneeMentioned: false,
        assigneeRawText: '',
        dueDate: null,
        priority: null,
        sourceMeetingId: null,
      };
      const explanation: VoiceDraft = {
        type: 'chat',
        reply: 'Похоже на событие календаря, но календарь доступен только руководителю — создал как задачу.',
      };
      return [taskDraft, explanation];
    }
    return [
      {
        type: 'chat',
        reply: 'Календарь доступен только руководителю — изменить или удалить встречу я не могу.',
      },
    ];
  }
}
