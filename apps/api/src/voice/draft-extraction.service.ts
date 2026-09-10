import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import { Role } from '@prisma/client';
import { nowInLocalTimezone, withLocalOffset } from '../common/timezone';
import type { VoiceDraft } from './dto/voice-draft-response.dto';

export interface EmployeeOption {
  id: string;
  fullName: string;
}

export interface TaskContextItem {
  id: string;
  title: string;
  status: string;
  assigneeName: string | null;
  dueDate: string | null;
}

export interface EventContextItem {
  id: string;
  title: string;
  location: string | null;
  startAt: string;
  endAt: string;
  allDay: boolean;
}

interface ExtractionResult {
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  clarificationNeeded: boolean;
  clarificationReason: string | null;
  drafts: VoiceDraft[];
}

// История диалога (аудит 10.09.2026, п. 2.9) — последние реплики этого же
// пользователя, и его самого, и ассистента, в хронологическом порядке.
// role здесь ровно то же, что и role в Anthropic messages API — не Role
// (владелец/сотрудник) из остальной схемы.
export interface VoiceHistoryItem {
  role: 'user' | 'assistant';
  text: string;
}

// Час — стандартная длительность встречи/созвона по умолчанию, если конец
// не назван явно ("завтра в 15:00" без "до 16:00" или "на час").
const DEFAULT_EVENT_DURATION_MS = 60 * 60 * 1000;

function normalizeDraftDates(draft: VoiceDraft): VoiceDraft {
  if (draft.type === 'task_action') {
    return { ...draft, dueDate: withLocalOffset(draft.dueDate) };
  }
  if (draft.type === 'event_action') {
    const startAt = withLocalOffset(draft.startAt);
    let endAt = withLocalOffset(draft.endAt);
    // Владелец 10.09.2026, найдено в проде: Claude иногда называет только
    // начало встречи ("создай встречу завтра в 15:00"), оставляя endAt
    // пустым — POST/PATCH события падал с "endAt must be a valid ISO 8601
    // date string", хотя сама встреча создавалась бы корректно с разумной
    // длительностью по умолчанию. При action='create' без явного конца —
    // подставляем начало + час, а не оставляем невалидным.
    if (draft.action === 'create' && startAt && !endAt) {
      endAt = new Date(new Date(startAt).getTime() + DEFAULT_EVENT_DURATION_MS).toISOString();
    }
    return { ...draft, startAt, endAt };
  }
  return draft; // chat — дат нет, нормализовать нечего
}

// Anthropic сначала отклонял схему с >16 nullable/anyOf-полями ("too many
// parameters with union types... limit: 16"), а после того как это было
// исправлено — ещё раз, уже с "The compiled grammar is too large... reduce
// the number of strict tools" (оба воспроизведены в проде 09.09.2026).
// Причина второй ошибки — не количество nullable-полей, а сама структура:
// 7 крупных веток анyOf (task/event/chat/update_task/delete_task/
// update_event/delete_event) компилируются в грамматику размером примерно
// как 7 отдельных инструментов. Решение — объединить create/update/delete
// для задачи и для события каждый в ОДНУ ветку с полем action, вместо трёх
// отдельных: было 7 веток, стало 3 (task_action/event_action/chat). См.
// подробный комментарий в voice-draft-response.dto.ts про семантику
// action и null/"" как "не упомянуто".
const OPTIONAL_STRING = { type: 'string' } as const;
// id-поля не ограничены enum'ом реального списка — сам enum с десятками
// id, повторённый в нескольких местах схемы, тоже раздувает грамматику.
// Принадлежность списку (задача/событие/сотрудник существует и виден
// пользователю) проверяется после ответа модели, не схемой (см.
// VoiceService.validateReferences/validateTarget).
const NULLABLE_ID = { anyOf: [{ type: 'string' }, { type: 'null' }] } as const;
const ID_ARRAY = { type: 'array', items: { type: 'string' } } as const;

const NULLABLE_BOOLEAN = { anyOf: [{ type: 'boolean' }, { type: 'null' }] } as const;
const NULLABLE_DATE_TIME = { anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }] } as const;
const NULLABLE_PRIORITY = {
  anyOf: [{ type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] }, { type: 'null' }],
} as const;

// Верхний уровень схемы — массив drafts, не одиночный draft (владелец
// 10.09.2026, см. подробный комментарий у VoiceParseResponse в
// voice-draft-response.dto.ts): один транскрипт может содержать несколько
// самостоятельных команд подряд ("удали встречу с Петром и создай новую на
// пятницу"). Потолок на число элементов — MAX_DRAFTS_PER_NOTE, экспортирован
// и применяется постфактум в VoiceService (Anthropic отклоняет строгую схему
// с "For 'array' type, property 'maxItems' is not supported" — найдено в
// проде 10.09.2026 сразу же при первом реальном вызове после этого
// изменения; тот же общий принцип, что и с enum'ами реальных id раньше —
// ограничения, которые Anthropic не даёт выразить в самой схеме, проверяются
// после ответа модели, не схемой).
export const MAX_DRAFTS_PER_NOTE = 5;

function buildDraftTool(): Anthropic.Tool {
  return {
    name: 'create_draft',
    description:
      'Разобрать транскрипт голосового сообщения на одну или несколько самостоятельных команд: попытка поставить/отредактировать/удалить задачу или событие, вопрос, реплика или неразборчивая запись — по одному структурированному черновику на каждую.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        confidence: { type: 'string', enum: ['HIGH', 'MEDIUM', 'LOW'] },
        clarificationNeeded: { type: 'boolean' },
        clarificationReason: OPTIONAL_STRING,
        drafts: {
          // Ни minItems, ни maxItems сюда не добавлять — Anthropic отвечает
          // 400 "For 'array' type, property 'maxItems' is not supported"
          // на строгой схеме (см. комментарий у MAX_DRAFTS_PER_NOTE выше).
          type: 'array',
          items: {
            anyOf: [
              {
                // Создание/редактирование/удаление задачи — одна ветка,
                // различаются полем action (владелец 09.09.2026, см.
                // комментарий у buildDraftTool выше). targetTaskId — '' при
                // action='create'; иначе id из таблицы задач в промпте
                // (проверяется после ответа модели, не схемой).
                type: 'object',
                properties: {
                  type: { const: 'task_action' },
                  action: { type: 'string', enum: ['create', 'update', 'delete'] },
                  targetTaskId: { type: 'string' },
                  targetTitle: { type: 'string' },
                  title: { type: 'string' },
                  description: OPTIONAL_STRING,
                  assigneeId: NULLABLE_ID,
                  dueDate: NULLABLE_DATE_TIME,
                  priority: NULLABLE_PRIORITY,
                },
                required: [
                  'type',
                  'action',
                  'targetTaskId',
                  'targetTitle',
                  'title',
                  'description',
                  'assigneeId',
                  'dueDate',
                  'priority',
                ],
                additionalProperties: false,
              },
              {
                type: 'object',
                properties: {
                  type: { const: 'event_action' },
                  action: { type: 'string', enum: ['create', 'update', 'delete'] },
                  targetEventId: { type: 'string' },
                  targetTitle: { type: 'string' },
                  title: { type: 'string' },
                  description: OPTIONAL_STRING,
                  location: OPTIONAL_STRING,
                  startAt: NULLABLE_DATE_TIME,
                  endAt: NULLABLE_DATE_TIME,
                  allDay: NULLABLE_BOOLEAN,
                  // При action='create' — начальный список участников; при
                  // 'update' — кого добавить. removeParticipantIds имеет
                  // смысл только при 'update'.
                  addParticipantIds: ID_ARRAY,
                  removeParticipantIds: ID_ARRAY,
                },
                required: [
                  'type',
                  'action',
                  'targetEventId',
                  'targetTitle',
                  'title',
                  'description',
                  'location',
                  'startAt',
                  'endAt',
                  'allDay',
                  'addParticipantIds',
                  'removeParticipantIds',
                ],
                additionalProperties: false,
              },
              {
                // Не всё сказанное — попытка продиктовать задачу/событие:
                // вопрос, реплика, реакция на предыдущий ответ, неразборчивая
                // или пустая запись. Для этого — обычный текстовый ответ в
                // чате, без создания чего-либо (раздел 10.3 ТЗ: не гадать —
                // либо честно сделать то, что попросили, либо ответить, а не
                // выдумывать задачу из непонятного).
                type: 'object',
                properties: {
                  type: { const: 'chat' },
                  reply: { type: 'string' },
                },
                required: ['type', 'reply'],
                additionalProperties: false,
              },
            ],
          },
        },
      },
      required: ['confidence', 'clarificationNeeded', 'clarificationReason', 'drafts'],
      additionalProperties: false,
    },
  };
}

function formatTaskContext(tasks: TaskContextItem[]): string {
  if (tasks.length === 0) return '(нет ни одной задачи)';
  return tasks
    .map((t) => {
      const parts = [`статус: ${t.status}`];
      if (t.assigneeName) parts.push(`исполнитель: ${t.assigneeName}`);
      if (t.dueDate) parts.push(`срок: ${t.dueDate}`);
      return `- ${t.id}: "${t.title}" (${parts.join(', ')})`;
    })
    .join('\n');
}

function formatEventContext(events: EventContextItem[]): string {
  if (events.length === 0) return '(нет предстоящих событий)';
  return events
    .map((e) => {
      const parts = [`начало: ${e.startAt}`, `конец: ${e.endAt}`];
      if (e.allDay) parts.push('весь день');
      if (e.location) parts.push(`место: ${e.location}`);
      return `- ${e.id}: "${e.title}" (${parts.join(', ')})`;
    })
    .join('\n');
}

export interface MeetingVoiceContext {
  title: string;
  summary: string;
}

function buildSystemPrompt(
  nowIso: string,
  employees: EmployeeOption[],
  role: Role,
  tasks: TaskContextItem[],
  events: EventContextItem[],
  meetingContext: MeetingVoiceContext | null,
): string {
  const employeeTable =
    employees.length > 0
      ? employees.map((e) => `- ${e.id}: ${e.fullName}`).join('\n')
      : '(список пуст)';

  const eventRule =
    role === Role.OWNER
      ? 'Пользователь — руководитель, ему доступен и календарь, и задачи.'
      : 'Пользователь — не руководитель, у него НЕТ доступа к календарю. Если транскрипт похож на событие/встречу (создание, изменение или удаление), всё равно НИКОГДА не выбирай draft.type = "event_action" для него — создание оформляй как задачу (type = "task_action", action = "create") с clarificationNeeded = true и clarificationReason, объясняющим, что календарь доступен только руководителю; изменение/удаление встречи — просто draft.type = "chat" с тем же объяснением. По той же причине, если он спросит про встречи/календарь ("что у меня завтра", "какие встречи на неделе") — в ответе (type = "chat") честно объясни, что календарь доступен только руководителю, не выдумывая события.';

  const calendarSection =
    role === Role.OWNER
      ? `Предстоящие события в календаре пользователя (для ответа на вопросы по пункту 3, и как закрытый список targetEventId для action='update'/'delete'):\n${formatEventContext(events)}`
      : '(календарь этому пользователю недоступен — см. правило ниже)';

  const meetingSection = meetingContext
    ? `\nПользователь сейчас смотрит саммари встречи «${meetingContext.title}»:\n${meetingContext.summary}\n\nЕсли голосовая заметка похожа на постановку задачи по мотивам этой встречи (например, ссылается на "эту задачу", человека или тему из саммари) — используй этот контекст, чтобы понять, о чём речь, и сформулировать title/description понятнее. Если заметка не связана со встречей — просто игнорируй этот раздел.\n`
    : '';

  return `Ты — голосовой ассистент «Адъютант» в корпоративной системе задач для руководителя и сотрудников. Пользователь наговаривает голосовую заметку в приложении; ты слышишь только её транскрипт, без интонаций. Вызови инструмент create_draft ровно один раз.

Транскрипт может содержать НЕСКОЛЬКО самостоятельных команд подряд — например, "удали встречу с Петром и создай новую на пятницу в 15:00" это ДВЕ команды, а не одна. Поле drafts — массив: один элемент на каждую самостоятельную команду, в том порядке, в котором они прозвучали. Обычная однозадачная заметка — массив из одного элемента, это норма, а не исключение. Не пытайся втиснуть две разные команды в один элемент и не игнорируй вторую — если распознал несколько, верни несколько элементов. Ниже "draft"/"этот элемент" — про один элемент массива drafts, правила одинаковы для каждого из них.

Выше в истории сообщений — предыдущие реплики этого же разговора (и пользователя, и твои), если они были; последнее сообщение user — это транскрипт, который нужно разобрать сейчас. Если он звучит как продолжение, уточнение или исправление того, что обсуждалось в предыдущих репликах ("не Ивану, а Петру", "перенеси на вторник", "да, именно так", "отмени это") — используй историю, чтобы понять, к чему это относится, вместо того чтобы разбирать заметку как отдельную самостоятельную мысль. Если истории нет или заметка явно не связана с ней — разбирай как обычно.
${meetingSection}

ГЛАВНОЕ РЕШЕНИЕ — что перед тобой. Задачи и встречи — это draft.type = "task_action"/"event_action" с полем action = "create"/"update"/"delete":
1. Попытка поставить НОВУЮ задачу ("напомни...", "нужно сделать...", "поставь Ивану...") → type="task_action", action="create". targetTaskId="" (задачи ещё нет).
2. Попытка создать НОВОЕ событие календаря ("встреча завтра в...", "созвон в 15:00..."), в том числе с участниками ("встреча с Иваном и Петром") → type="event_action", action="create", targetEventId="". addParticipantIds — те, кого назвали (для create это начальный список участников). startAt ОБЯЗАТЕЛЕН — если время начала вообще не названо, это не полноценная попытка создать событие, оформи как type="chat" с уточняющим вопросом о времени. endAt указывай, если названа продолжительность или явное время окончания ("до 16:00", "на час"); если названо только начало — оставь endAt = null, сервер сам подставит длительность по умолчанию (час).
3. Вопрос о СУЩЕСТВУЮЩЕЙ задаче или событии — статус, срок, что запланировано ("какой статус у задачи...", "что там с отчётом для Иванова", "что у меня завтра", "какие встречи на этой неделе") → draft.type = "chat", ответь по данным из таблиц ниже (задачи/календарь), не выдумывая. Ищи задачу по смыслу названия, не только по точному совпадению слов. Если подходящей записи не нашлось — так и скажи, а не изобретай ответ. Не путай с пунктами 1/2: "какой статус у задачи Х" — это вопрос (пункт 3), а не постановка новой задачи с названием "статус".
4. ВСЁ ОСТАЛЬНОЕ — вопрос не про задачи/календарь, реплика, реакция на твой предыдущий ответ ("что значит...", "я не понял", "почему"), короткая/неразборчивая/пустая запись, бессвязный обрывок — → draft.type = "chat", поле reply = обычный связный ответ на русском по существу сказанного.
5. Изменение СУЩЕСТВУЮЩЕЙ задачи ("перенеси задачу Х на пятницу", "назначь эту задачу Ивану", "сделай задачу Х высоким приоритетом") → type="task_action", action="update". targetTaskId — выбери задачу из списка ниже по смыслу названия, targetTitle — её название (для текста подтверждения). Заполняй ТОЛЬКО реально упомянутые поля: title/description — пустая строка "", если не упомянуты (не трогать поле, а не "очистить"); assigneeId/dueDate/priority — null, если не упомянуты.
6. Изменение СУЩЕСТВУЮЩЕЙ встречи, включая добавление/снятие участника ("добавь Ивана на встречу с Азаматом", "убери Петра со встречи завтра", "перенеси встречу на 16:00") → type="event_action", action="update". targetEventId — выбери событие из списка ниже, targetTitle — его название. addParticipantIds/removeParticipantIds — только реально упомянутые сотрудники (для update это "кого добавить"/"кого убрать", НЕ полный список участников). title/description/location — пустая строка "", если не упомянуты; startAt/endAt/allDay — null, если не упомянуты.
7. Удаление СУЩЕСТВУЮЩЕЙ задачи или встречи ("удали задачу Х", "отмени встречу с Азаматом") → type="task_action"/"event_action", action="delete", targetTaskId/targetEventId и targetTitle заполнены, остальные поля можно оставить пустыми/null — ничего не удаляется этим ответом, подтверждение на стороне пользователя.
Не выдумывай задачу из того, что задачей не является — раньше так создавались бессмысленные задачи-заглушки вместо ответа человеку; это неверное поведение. Если сомневаешься, что перед тобой дословно является постановкой НОВОЙ задачи/события, изменением/удалением СУЩЕСТВУЮЩЕЙ, а не вопросом о существующих/просьбой/вопросом — выбирай "chat" и ответь по-человечески.

ДВУСМЫСЛЕННОСТЬ — НЕ УГАДЫВАЙ. Если под упомянутое имя подходит несколько сотрудников (например, два "Алексея"), или под описание подходит несколько задач/встреч, или ни одна не подходит уверенно — НЕ выбирай наугад ни assigneeId/addParticipantIds, ни targetTaskId/targetEventId. Вместо этого верни draft.type = "chat" с вежливым уточняющим вопросом, называющим все подходящие варианты (например, "Уточните, пожалуйста: Алексей Иванов или Алексей Петров?"). Это относится и к обычному назначению исполнителя (пункт 1), не только к пунктам 5-7.

Для type = "chat" отвечай коротко, дружелюбно и по делу, как будто ты — часть этого приложения:
- Если это вопрос про задачу или календарь — используй таблицы данных ниже, отвечай конкретно (статус, срок, исполнитель, время встречи), не выдумывай факты, которых там нет.
- Если это вопрос о том, что ты только что сделал(а) или почему — объясни своими словами (например, "уточнить формулировку" означает, что предыдущая заметка была слишком неясной, чтобы понять задачу).
- Если запись похожа на пустоту/шум/обрыв ("Продолжение следует...", случайные звуки) — вежливо попроси повторить.
- На обычный вопрос или реплику — ответь по существу, не притворяйся, что не понимаешь.

Текущие дата и время — уже по местному времени пользователя (Казахстан, UTC+5), используй как есть для разрешения относительных выражений вроде "завтра", "в пятницу", "через час": ${nowIso}

Все поля с датой/временем (dueDate, startAt, endAt) заполняй ТОЖЕ по этому же местному времени пользователя, БЕЗ суффикса Z и без смещения часового пояса (просто "2026-09-02T13:00:00", как в примере выше) — если сказали "в 13:00", в поле должно быть ровно 13:00, без пересчёта в UTC. Часовой пояс сервер подставит сам. Даты в таблицах задач/календаря ниже — тоже местное время пользователя (уже со смещением +05:00 на конце), ориентируйся на них как есть при ответе на вопросы.

Сотрудники (id: имя) — используй как закрытый список для assigneeId/addParticipantIds/removeParticipantIds, если в тексте назван человек; если не назван, не удаётся сопоставить или сопоставляется НЕСКОЛЬКИМ сотрудникам сразу — см. правило "ДВУСМЫСЛЕННОСТЬ" выше:
${employeeTable}

Актуальные задачи, которые видит этот пользователь (для ответа на вопросы по пункту 3, и как закрытый список targetTaskId для action='update'/'delete'):
${formatTaskContext(tasks)}

${calendarSection}

${eventRule}

Для type = "task_action"/"event_action": если формулировка неоднозначна, но всё же похожа на попытку поставить/изменить/удалить задачу или событие — верни confidence = "LOW", clarificationNeeded = true и понятную clarificationReason, но не отказывайся от черновика. Для type = "chat" — confidence = "HIGH", clarificationNeeded = false, clarificationReason = null (уточнение теперь и есть сам ответ в reply).`;
}

// Anthropic messages API ожидает строгое чередование user/assistant.
// history в норме уже чередуется (VoiceService пишет реплику пользователя
// сама, фронтенд — финальный текст ассистента отдельным вызовом), но если
// фронтенд не успел залогировать ответ ассистента до следующей заметки
// (сеть, закрытая вкладка) — подряд могут оказаться две реплики user.
// Склеиваем соседние реплики одной роли переносом строки вместо того, чтобы
// упасть на валидации Anthropic.
function toAnthropicMessages(history: VoiceHistoryItem[], transcript: string): Anthropic.MessageParam[] {
  const items: VoiceHistoryItem[] = [...history, { role: 'user', text: transcript }];
  const messages: Anthropic.MessageParam[] = [];
  for (const item of items) {
    const last = messages[messages.length - 1];
    if (last && last.role === item.role && typeof last.content === 'string') {
      last.content = `${last.content}\n${item.text}`;
    } else {
      messages.push({ role: item.role, content: item.text });
    }
  }
  return messages;
}

// Каскад моделей вместо одной фиксированной: Haiku на порядок быстрее Opus
// (структурированное извлечение по строгой schema — для неё тривиальная
// задача в подавляющем большинстве случаев), поэтому типичная короткая
// диктовка получает ответ почти мгновенно. Opus подключается только когда
// сама Haiku возвращает LOW confidence или clarificationNeeded — то есть
// когда транскрипт действительно неоднозначен и стоит заплатить лишней
// секундой-двумя за более сильный разбор, а не платить ей всегда.
const FAST_MODEL = 'claude-haiku-4-5-20251001';
const STRONG_MODEL = 'claude-opus-5';

// Один forced tool-use вызов — не агентный луп, не Tool Runner: нужен ровно
// один структурированный ответ, а не многошаговое выполнение инструментов.
@Injectable()
export class DraftExtractionService {
  private client: Anthropic | null = null;

  constructor(private readonly config: ConfigService) {}

  // Ленивая инициализация — см. тот же комментарий в WhisperService: Nest
  // создаёт провайдеры при старте, getOrThrow() в конструкторе уронил бы
  // весь API-процесс при отсутствии ANTHROPIC_API_KEY, а не только эту
  // функцию.
  private getClient(): Anthropic {
    if (!this.client) {
      this.client = new Anthropic({ apiKey: this.config.getOrThrow<string>('ANTHROPIC_API_KEY') });
    }
    return this.client;
  }

  private async callModel(
    model: string,
    messages: Anthropic.MessageParam[],
    tool: Anthropic.Tool,
    system: string,
  ): Promise<ExtractionResult> {
    const response = await this.getClient().messages.create({
      model,
      // 1024 хватало на один draft; с переходом на drafts: VoiceDraft[]
      // (до MAX_DRAFTS_PER_NOTE=5, каждый — до 12 полей, включая массивы
      // участников) ответ мог не влезть и оборваться на середине tool_use
      // JSON (владелец 10.09.2026). 2048 — запас с кратным множителем, не
      // впритык к худшему случаю.
      max_tokens: 2048,
      // effort — параметр только для Opus; Haiku 4.5 на него отвечает 400
      // "This model does not support the effort parameter" (найдено в
      // проде 08.09.2026 — первый реальный вызов после переключения на
      // каскад упал с Internal Server Error).
      ...(model === STRONG_MODEL ? { output_config: { effort: 'low' as const } } : {}),
      system,
      tools: [tool],
      tool_choice: { type: 'tool', name: 'create_draft' },
      messages,
    });

    const block = response.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    );
    if (!block) {
      throw new InternalServerErrorException('Claude не вернул структурированный черновик');
    }

    return block.input as ExtractionResult;
  }

  async extract(
    transcript: string,
    employees: EmployeeOption[],
    role: Role,
    tasks: TaskContextItem[],
    events: EventContextItem[],
    meetingContext: MeetingVoiceContext | null = null,
    history: VoiceHistoryItem[] = [],
  ): Promise<ExtractionResult> {
    const tool = buildDraftTool();
    const system = buildSystemPrompt(nowInLocalTimezone(), employees, role, tasks, events, meetingContext);
    const messages = toAnthropicMessages(history, transcript);

    let raw = await this.callModel(FAST_MODEL, messages, tool, system);
    if (raw.confidence === 'LOW' || raw.clarificationNeeded) {
      raw = await this.callModel(STRONG_MODEL, messages, tool, system);
    }

    return { ...raw, drafts: raw.drafts.map(normalizeDraftDates) };
  }
}
