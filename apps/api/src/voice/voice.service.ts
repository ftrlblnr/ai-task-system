import { randomUUID } from 'crypto';
import { BadRequestException, Injectable } from '@nestjs/common';
import { Role, VoiceMessageRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { TasksService } from '../tasks/tasks.service';
import { EventsService } from '../calendar/events.service';
import { WhisperService } from './whisper.service';
import { DraftExtractionService, formatLocalDateTime, type VoiceHistoryItem } from './draft-extraction.service';
import type { VoiceDraft, VoiceParseResponse } from './dto/voice-draft-response.dto';

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
    // здесь он ещё не известен для task_action/event_action (зависит от
    // того, успешно ли выполнится мутация на клиенте).
    await this.prisma.voiceMessage.create({
      data: { employeeId: user.id, role: VoiceMessageRole.USER, text: transcript },
    });
    // id больше не ограничены enum'ом в схеме инструмента (Anthropic
    // отклоняет схему целиком, если она "слишком большая" — см. комментарий
    // в draft-extraction.service.ts у NULLABLE_ID) — проверяем сами, что
    // Claude не "придумала" несуществующий/невидимый id.
    const validatedTarget = this.validateTarget(
      result.draft,
      new Set(taskContext.map((t) => t.id)),
      new Set(eventContext.map((e) => e.id)),
    );
    const withCompleteEvent = this.validateEventCreateCompleteness(validatedTarget);
    const validatedRefs = this.validateReferences(withCompleteEvent, new Set(employees.map((e) => e.id)));
    const enrichedDraft = this.attachAssigneeName(validatedRefs, employees);
    const withMeeting = this.attachSourceMeeting(enrichedDraft, meetingId, meetingContext);
    const draft = this.enforceEventRbac(withMeeting, user.role);

    // Раздел 15 ТЗ: голосовые заметки — чувствительный контент. Логируем сам
    // факт транскрибации/разбора, не текст транскрипта. randomUUID(), а не
    // константа — черновик эфемерный, своего id в БД у него нет, но записи
    // аудита не должны схлопываться в одну неразличимую строку.
    await this.audit.log(user.id, 'TRANSCRIBE', 'VoiceDraft', randomUUID(), {
      draftType: draft.type,
      confidence: result.confidence,
    });

    // enforceEventRbac подменяет черновик двумя способами: event_action
    // create -> task_action create (нужно уточнение формулировки) или
    // event_action update/delete -> chat (объяснение уже в самом reply,
    // доп. уточнение не нужно). Сравниваем типы/action явно, а не ссылки —
    // validateReferences выше всегда создаёт новый объект через spread даже
    // когда ничего не поменялось, так что draft !== result.draft больше не
    // сигнализирует "было подменено".
    const wasDowngradedToTask =
      result.draft.type === 'event_action' && result.draft.action === 'create' && draft.type === 'task_action';

    return {
      transcript,
      confidence: result.confidence,
      clarificationNeeded: wasDowngradedToTask || result.clarificationNeeded,
      clarificationReason: wasDowngradedToTask
        ? 'Похоже на событие календаря, но календарь доступен только руководителю — уточните формулировку задачи.'
        : result.clarificationReason,
      draft,
    };
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
  // чат-пузыре ассистента становится окончательным — chat-реплика сразу,
  // итог создания/редактирования/удаления или текст ошибки после того, как
  // соответствующий запрос (POST/PATCH/DELETE /tasks или /events)
  // выполнится или упадёт. См. комментарий у модели VoiceMessage в schema.prisma
  // про то, почему это не пишется здесь же, в parse().
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
  private enforceEventRbac(draft: VoiceDraft, role: Role): VoiceDraft {
    if (role === Role.OWNER || draft.type !== 'event_action') return draft;

    if (draft.action === 'create') {
      return {
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
    }
    return {
      type: 'chat',
      reply: 'Календарь доступен только руководителю — изменить или удалить встречу я не могу.',
    };
  }
}
