import { randomUUID } from 'crypto';
import { BadRequestException, Injectable } from '@nestjs/common';
import { Role, VoiceMessageRole } from '@prisma/client';
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
import { WhisperService } from './whisper.service';
import { DraftExtractionService, MAX_DRAFTS_PER_NOTE, type VoiceHistoryItem } from './draft-extraction.service';
import type {
  EventRevertPayload,
  TaskRevertPayload,
  VoiceActionResult,
  VoiceDraft,
  VoiceEventActionDraft,
  VoiceEventActionResult,
  VoiceParseResponse,
  VoiceTaskActionDraft,
  VoiceTaskActionResult,
} from './dto/voice-draft-response.dto';

// HttpException'ы (ForbiddenException/NotFoundException/BadRequestException
// и т.п.) везде в проекте конструируются с обычной строкой — .message уже
// человекочитаемый текст, тот же, что ушёл бы клиенту при вызове через
// HTTP. Раньше эти же сообщения пользователь видел как ответ на PATCH/
// DELETE с фронтенда (аудит 10.09.2026, п. 2.11) — теперь мутация внутри
// parse(), но текст ошибки в чате должен остаться тем же.
function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Не удалось выполнить действие';
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

@Injectable()
export class VoiceService {
  constructor(
    private readonly whisper: WhisperService,
    private readonly extraction: DraftExtractionService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly tasks: TasksService,
    private readonly events: EventsService,
  ) {}

  async parse(
    audio: MulterFile | undefined,
    user: AuthenticatedUser,
    meetingId?: string,
  ): Promise<VoiceParseResponse> {
    // fileFilter в FileInterceptor отклоняет неподдерживаемый mime через
    // cb(null, false) — файл молча не попадает в запрос, а не кидает ошибку,
    // поэтому здесь audio может быть undefined и это нужно проверять явно.
    if (!audio) {
      throw new BadRequestException('Аудио не получено или формат файла не поддерживается');
    }

    // Диктовка со страницы встречи (владелец 09.09.2026) — доступно только
    // руководителю (сам /meetings и так открыт лишь ему), тот же принцип,
    // что sourceMeetingId-проверка в TasksService.create(). Прямой prisma-
    // запрос, а не MeetingsService.findOne() — тот пишет audit-log READ на
    // каждый вызов, здесь это не нужный побочный эффект.
    const meetingContext =
      meetingId && user.role === Role.OWNER
        ? await this.prisma.meeting.findUnique({
            where: { id: meetingId },
            select: { title: true, rawSummary: true, enhancedSummary: true },
          })
        : null;

    const transcript = await this.whisper.transcribe(audio.buffer, audio.mimetype, audio.originalname);

    const employees = await this.prisma.employee.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true, fullName: true },
    });

    // Те же findAll, что отдают обычные списки задач/календаря в UI — те же
    // правила видимости (сотрудник видит своё, руководитель — всё;
    // календарь целиком закрыт на OWNER), без отдельной копии RBAC здесь.
    // Без Promise.all — оба запроса быстрые (<50мс), а смешение типов
    // (Event[] на одной ветке, [] на другой) через тернарник внутри
    // Promise.all схлопывает элемент в never для TS.
    const visibleTasks = await this.tasks.findAll(user);
    const visibleEvents = user.role === Role.OWNER ? await this.events.findAll(user.id) : [];

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

    const history = await this.loadHistory(user.id);

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
    );

    // Реплику пользователя пишем сама — транскрипт уже есть на сервере.
    // Финальный текст ответа ассистента (chat-реплика, итог действия или
    // текст ошибки) пишет фронтенд отдельно, см. logAssistantMessage ниже —
    // он собирает его из VoiceActionResult, который возвращает этот метод
    // (действие уже выполнено на момент ответа, см. комментарий у
    // VoiceParseResponse в dto).
    await this.prisma.voiceMessage.create({
      data: { employeeId: user.id, role: VoiceMessageRole.USER, text: transcript },
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
    const drafts = result.drafts.slice(0, MAX_DRAFTS_PER_NOTE).flatMap((draft) => {
      const validatedTarget = this.validateTarget(draft, taskIds, eventIds);
      const withCompleteEvent = this.validateEventCreateCompleteness(validatedTarget);
      const validatedRefs = this.validateReferences(withCompleteEvent, employeeIds);
      const enrichedDraft = this.attachAssigneeName(validatedRefs, employees);
      const withMeeting = this.attachSourceMeeting(enrichedDraft, meetingId, meetingContext);
      return this.enforceEventRbac(withMeeting, user.role);
    });

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
    const results: VoiceActionResult[] = [];
    for (const draft of drafts) {
      if (draft.type === 'chat') {
        results.push({ type: 'chat', reply: draft.reply });
      } else if (draft.type === 'task_action') {
        results.push(await this.executeTaskAction(draft, user));
      } else {
        results.push(await this.executeEventAction(draft, user));
      }
    }

    // Раздел 15 ТЗ: голосовые заметки — чувствительный контент. Логируем сам
    // факт транскрибации/разбора и её исход, не текст транскрипта.
    // randomUUID(), а не константа — черновик эфемерный, своего id в БД у
    // него нет, но записи аудита не должны схлопываться в одну
    // неразличимую строку.
    await this.audit.log(user.id, 'TRANSCRIBE', 'VoiceDraft', randomUUID(), {
      draftTypes: drafts.map((d) => d.type),
      outcomes: results.map((r) => (r.type === 'chat' ? 'chat' : r.ok ? 'ok' : 'error')),
      confidence: result.confidence,
    });

    return {
      transcript,
      confidence: result.confidence,
      clarificationNeeded: result.clarificationNeeded,
      clarificationReason: result.clarificationReason,
      results,
    };
  }

  // Создаёт/обновляет/удаляет задачу напрямую через TasksService (та же
  // RBAC-проверка, что у обычного PATCH/DELETE /tasks/:id — не дублируем
  // её здесь) и возвращает итог вместо черновика. previous — снимок ДО
  // мутации тех полей, что реально меняются (черновик несёт только новые
  // значения), нужен фронтенду для кнопки "Отменить" (UNDO_WINDOW_MS).
  private async executeTaskAction(draft: VoiceTaskActionDraft, user: AuthenticatedUser): Promise<VoiceTaskActionResult> {
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
        return { type: 'task_action', draft, ok: true, error: null, taskId: created.id, previous: null };
      }

      if (draft.action === 'update') {
        const dto: Partial<CreateTaskDto> = {};
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
        if (dto.dueDate !== undefined) previous.dueDate = before.dueDate ?? null;
        if (dto.priority !== undefined) previous.priority = before.priority;

        await this.tasks.update(draft.targetTaskId, dto as UpdateTaskDto, user);
        return { type: 'task_action', draft, ok: true, error: null, taskId: draft.targetTaskId, previous };
      }

      // delete — без дополнительного подтверждения (владелец 10.09.2026:
      // "по удалению давай доверять", после практической проверки).
      await this.tasks.remove(draft.targetTaskId, user);
      return { type: 'task_action', draft, ok: true, error: null, taskId: draft.targetTaskId, previous: null };
    } catch (err) {
      return { type: 'task_action', draft, ok: false, error: toErrorMessage(err), taskId: null, previous: null };
    }
  }

  // Аналог executeTaskAction для событий — EventsService.create/update/
  // remove/addParticipant/removeParticipant принимают employeeId, не весь
  // AuthenticatedUser (весь модуль и так закрыт на Role.OWNER на уровне
  // контроллера, см. комментарий в events.service.ts); enforceEventRbac
  // выше гарантирует, что сюда event_action от не-OWNER не попадает.
  private async executeEventAction(draft: VoiceEventActionDraft, user: AuthenticatedUser): Promise<VoiceEventActionResult> {
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
        return { type: 'event_action', draft, ok: true, error: null, eventId: created.id, previous: null };
      }

      if (draft.action === 'update') {
        const dto: Partial<CreateEventDto> = {};
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
          await this.events.update(draft.targetEventId, dto as UpdateEventDto, user.id);
        }
        for (const employeeId of draft.addParticipantIds) {
          await this.events.addParticipant(draft.targetEventId, employeeId).catch(() => {});
        }
        for (const employeeId of draft.removeParticipantIds) {
          await this.events.removeParticipant(draft.targetEventId, employeeId).catch(() => {});
        }
        return { type: 'event_action', draft, ok: true, error: null, eventId: draft.targetEventId, previous };
      }

      // delete — без дополнительного подтверждения, тот же принцип, что и
      // для задач (владелец 10.09.2026).
      await this.events.remove(draft.targetEventId, user.id);
      return { type: 'event_action', draft, ok: true, error: null, eventId: draft.targetEventId, previous: null };
    } catch (err) {
      return { type: 'event_action', draft, ok: false, error: toErrorMessage(err), eventId: null, previous: null };
    }
  }

  // Последние реплики этого пользователя, в хронологическом порядке, в
  // пределах окна VOICE_HISTORY_MAX_AGE_MS — см. комментарий у констант
  // выше. findMany с take по индексу [employeeId, createdAt] дёшев
  // независимо от того, сколько всего реплик накопилось за всё время.
  private async loadHistory(employeeId: string): Promise<VoiceHistoryItem[]> {
    const rows = await this.prisma.voiceMessage.findMany({
      where: { employeeId, createdAt: { gte: new Date(Date.now() - VOICE_HISTORY_MAX_AGE_MS) } },
      orderBy: { createdAt: 'desc' },
      take: VOICE_HISTORY_LIMIT,
      select: { role: true, text: true },
    });
    return rows.reverse().map((r) => ({ role: r.role === VoiceMessageRole.USER ? 'user' : 'assistant', text: r.text }));
  }

  // Вызывается фронтендом (POST /voice/messages) в момент, когда текст в
  // чат-пузыре ассистента становится окончательным — chat-реплика, итог
  // действия (ok/error уже известны из VoiceActionResult, action выполнено
  // внутри parse(), см. п. 2.11) или текст после отдельного вызова undo.
  // См. комментарий у модели VoiceMessage в schema.prisma про то, почему
  // это не пишется здесь же, в parse().
  async logAssistantMessage(text: string, user: AuthenticatedUser): Promise<void> {
    await this.prisma.voiceMessage.create({
      data: { employeeId: user.id, role: VoiceMessageRole.ASSISTANT, text },
    });
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
