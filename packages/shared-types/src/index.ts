// Типы, общие для apps/api и apps/web. Дублируют форму Prisma-enum'ов и
// select-проекций API вручную (пакет не зависит от @prisma/client), чтобы
// Prisma не тянулась в браузерный бандл web-приложения.

export type Role = 'OWNER' | 'EMPLOYEE';

export type EmployeeStatus = 'ACTIVE' | 'INACTIVE';

export type TaskStatus =
  | 'DRAFT'
  | 'NEW'
  | 'IN_PROGRESS'
  | 'IN_REVIEW'
  | 'DONE'
  | 'RETURNED'
  | 'CANCELLED';

export type TaskPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

// Раздел 12 ТЗ: уровни, а не проценты — самооценка LLM плохо
// откалибрована, показывать ложную точность пользователю не нужно.
export type ConfidenceLevel = 'HIGH' | 'MEDIUM' | 'LOW';

export interface EmployeeSummary {
  id: string;
  fullName: string;
}

export interface TaskProfileSummary {
  id: string;
  category: string;
  type: string;
}

export interface TaskListItem {
  id: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  dueDate: string | null;
  aiConfidence: ConfidenceLevel | null;
  createdAt: string;
  taskProfile: TaskProfileSummary | null;
  assignee: EmployeeSummary | null;
  creator: EmployeeSummary;
  // Подзадачи (владелец 08.09.2026) — только счётчики в списке, полный
  // список только в TaskDetail.subtasks.
  subtaskCount: number;
  subtaskDoneCount: number;
  // Вычисляемый признак (аудит 10.09.2026, п. 2.1), не статус — dueDate в
  // прошлом и status не DONE/CANCELLED. Раньше был отдельным хранимым
  // TaskStatus.OVERDUE, который крон перетирал поверх статуса, только что
  // выставленного сотрудником (IN_PROGRESS и т.п.).
  isOverdue: boolean;
}

export interface TaskSubtaskSummary {
  id: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  dueDate: string | null;
  assignee: EmployeeSummary | null;
}

export interface TaskComment {
  id: string;
  body: string;
  createdAt: string;
  author: EmployeeSummary;
}

export interface TaskHistoryEntry {
  id: string;
  field: string;
  oldValue: string | null;
  newValue: string | null;
  createdAt: string;
  changedBy: EmployeeSummary;
}

export interface MeetingRef {
  id: string;
  title: string;
  meetingDate: string;
}

export interface TaskDetail extends TaskListItem {
  description: string | null;
  // Раздел 9 ТЗ: источник — встреча (только заголовок+дата, не сам
  // протокол) + точный таймкод + краткий контекст происхождения задачи,
  // безопасный для показа исполнителю.
  sourceMeeting: MeetingRef | null;
  sourceTimestamp: string | null;
  sourceContext: string | null;
  // Заполнен, только если сама эта задача — подзадача (владелец 08.09.2026).
  parentTask: { id: string; title: string } | null;
  subtasks: TaskSubtaskSummary[];
  // Наблюдатели — видят задачу и получают уведомления, не входят в RBAC
  // смены статуса (модель «один ответственный + наблюдатели», не
  // множественное назначение).
  watchers: EmployeeSummary[];
  comments: TaskComment[];
  history: TaskHistoryEntry[];
}

export interface EmployeeProfile {
  id: string;
  fullName: string;
  photoUrl: string | null;
  email: string;
  telegramId: string | null;
  status: EmployeeStatus;
  role: Role;
  isProfileAdmin: boolean;
  positionId: string | null;
  position: { id: string; title: string } | null;
  createdAt: string;
}

export interface Position {
  id: string;
  title: string;
}

export interface Competency {
  id: string;
  name: string;
  description: string;
}

export interface EmployeeCompetencyEntry {
  description: string | null;
  competency: { id: string; name: string; description: string };
}

export interface EmployeeDetail extends EmployeeProfile {
  competencies: EmployeeCompetencyEntry[];
}

export interface CreateEmployeeInput {
  fullName: string;
  email: string;
  password: string;
  positionId?: string;
  role?: Role;
  isProfileAdmin?: boolean;
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  taskProfileId?: string;
  assigneeId?: string;
  // Подзадача — обычная задача с parentTaskId (владелец 08.09.2026, по
  // образцу Linear/Asana). Один уровень вложенности проверяет бэкенд.
  parentTaskId?: string;
  priority?: TaskPriority;
  dueDate?: string;
  sourceMeetingId?: string;
  sourceTimestamp?: string;
  sourceContext?: string;
  // Заполняется при постановке задач из саммари встречи (владелец
  // 09.09.2026) — уверенность Claude в этом черновике. При обычном ручном
  // создании не передаётся.
  aiConfidence?: ConfidenceLevel;
}

export interface MeetingSummary {
  id: string;
  title: string;
  meetingDate: string;
  createdBy: EmployeeSummary;
  createdAt: string;
  // Заполнено только у встреч, импортированных синхронизацией Plaud
  // (владелец 08.09.2026) — null у вручную созданных.
  plaudRecordingId: string | null;
}

export interface MeetingTaskRef {
  id: string;
  title: string;
  status: TaskStatus;
  sourceTimestamp: string | null;
}

export interface MeetingDetail extends MeetingSummary {
  rawSummary: string;
  enhancedSummary: string | null;
  // "Speaker N" -> реальное имя (владелец 09.09.2026) — из чего пересчитан
  // enhancedSummary. Null, пока имена не заданы.
  speakerNames: Record<string, string> | null;
  audioUrl: string | null;
  tasks: MeetingTaskRef[];
}

export interface CreateMeetingInput {
  title: string;
  meetingDate: string;
  rawSummary: string;
}

export interface UpdateMeetingSpeakersInput {
  speakerNames: Record<string, string>;
}

// Извлечение задач из саммари встречи (владелец 09.09.2026) — эфемерный
// черновик, тот же принцип, что VoiceTaskDraft: ничего не пишется в БД,
// пока руководитель не отредактирует и не подтвердит в модалке ревью.
export interface MeetingTaskDraft {
  title: string;
  description: string | null;
  assigneeId: string | null;
  assigneeName: string | null;
  dueDate: string | null;
  priority: TaskPriority | null;
  confidence: ConfidenceLevel;
  // Короткая цитата/пересказ фрагмента саммари, откуда взята задача.
  sourceContext: string;
}

export interface ExtractMeetingTasksResponse {
  drafts: MeetingTaskDraft[];
}

export interface TelegramInvite {
  token: string;
  expiresAt: string;
  deepLink: string | null;
}

// Владелец 08.09.2026 — self-service сброс пароля, тот же UX, что у
// TelegramInvite выше (сгенерировать ссылку, передать сотруднику лично).
export interface PasswordResetLink {
  link: string;
  expiresAt: string;
}

// Календарь руководителя (раздел 14.2 ТЗ / Адъютант, 28.08.2026) —
// двусторонне синхронизирован с Google Calendar.
export type EventStatus = 'DRAFT' | 'CONFIRMED' | 'CANCELLED';

export interface CalendarEvent {
  id: string;
  title: string;
  description: string | null;
  location: string | null;
  startAt: string;
  endAt: string;
  allDay: boolean;
  status: EventStatus;
  googleEventId: string | null;
  lastSyncedAt: string | null;
  createdAt: string;
  // Участники встречи (владелец 09.09.2026) — назначает только руководитель.
  participants: EmployeeSummary[];
}

export interface CreateEventInput {
  title: string;
  description?: string;
  location?: string;
  startAt: string;
  endAt: string;
  allDay?: boolean;
  status?: EventStatus;
}

export interface AddEventParticipantInput {
  employeeId: string;
}

// Синхронизация встреч из Plaud (владелец 08.09.2026). В отличие от
// GoogleCalendarStatus, здесь нет configured/clientId — self-service
// регистрации OAuth-приложения у Plaud для этого сценария нет (владелец
// 09.09.2026), используется публичный клиент официальных @plaud-ai/cli/mcp.
export interface PlaudStatus {
  connected: boolean;
  connectedAt?: string;
  lastSyncAt?: string | null;
}

// Голосовой режим Mini App (раздел 14.2 ТЗ / Адъютант) — POST /voice/parse.
// Действие выполняется сервером В ТОМ ЖЕ запросе (владелец 10.09.2026,
// аудит п. 2.11: раньше /voice/parse только возвращал черновик, а
// POST/PATCH/DELETE был отдельным запросом с фронтенда — если сеть
// падала между ними, Whisper+Claude уже оплачены, а задача не создана).
// Поля черновика подобраны так, чтобы бэкенду было удобно собрать из них
// тело мутации без доп. маппинга (см. CreateTaskInput/CreateEventInput
// выше) — сам черновик остаётся в VoiceActionResult ниже для текста в чате.
//
// Создание/редактирование/удаление объединены в ОДИН тип на задачу и ОДИН
// на событие (action: create/update/delete), а не в 6 отдельных типов —
// владелец 09.09.2026: Anthropic отклоняет строгую tool-схему с "The
// compiled grammar is too large" при большом числе крупных веток в схеме
// инструмента (было 7 веток: task/event/update_task/delete_task/
// update_event/delete_event/chat — сократили до 3).
//
// title/description/location — пустая строка "" означает "не упомянуто,
// не менять" при action='update', и одновременно "нет значения" при
// action='create' (для новой задачи/встречи это одно и то же). Остальные
// nullable-поля (assigneeId/dueDate/priority/startAt/endAt/allDay) — null
// означает то же самое. Голосовая ОЧИСТКА уже заполненного поля не
// поддерживается в этом заходе (осознанное упрощение) — только установка
// нового значения. Удаление (action='delete') выполняется сразу, без
// дополнительного подтверждения — владелец 10.09.2026: "по удалению давай
// доверять", сознательное решение после практической проверки (ранее
// требовало кнопок "Удалить"/"Отмена" в чате — распознавание речи было
// признано ненадёжной границей для необратимого действия; теперь риск
// принят, undo в течение 30 секунд остаётся подстраховкой, см. UndoInfo
// на фронтенде).
export interface VoiceTaskActionDraft {
  type: 'task_action';
  action: 'create' | 'update' | 'delete';
  targetTaskId: string; // '' при action='create' — задачи ещё не существует
  targetTitle: string; // для update/delete — название для текста подтверждения; для create совпадает с title
  title: string;
  description: string;
  assigneeId: string | null;
  assigneeName: string | null; // резолвит сервер, не поле схемы инструмента
  dueDate: string | null;
  priority: TaskPriority | null;
  // Заполнено, если диктовка начата со страницы встречи (владелец
  // 09.09.2026, /voice?meetingId=...) и action='create' — сервер сам
  // проставляет, не поле схемы инструмента Claude.
  sourceMeetingId: string | null;
}

export interface VoiceEventActionDraft {
  type: 'event_action';
  action: 'create' | 'update' | 'delete';
  targetEventId: string; // '' при action='create'
  targetTitle: string;
  title: string;
  description: string;
  location: string;
  startAt: string | null;
  endAt: string | null;
  allDay: boolean | null;
  // При action='create' — начальный список участников; при 'update' —
  // кого добавить. removeParticipantIds имеет смысл только при 'update'.
  addParticipantIds: string[];
  addParticipantNames: string[];
  removeParticipantIds: string[];
  removeParticipantNames: string[];
}

// Не всё сказанное — попытка поставить задачу/событие: вопрос, реплика,
// реакция на предыдущий ответ, неразборчивая запись. Раньше на это тоже
// создавалась задача-заглушка («Уточнить формулировку») — владелец
// 07.09.2026 указал, что ожидал живой ответ, а не мусор в списке задач.
export interface VoiceChatReply {
  type: 'chat';
  reply: string;
}

export type VoiceDraft = VoiceTaskActionDraft | VoiceEventActionDraft | VoiceChatReply;

// Снимок полей ДО применения голосового изменения (владелец 10.09.2026) —
// сервер строит его сам непосредственно перед мутацией (черновик несёт
// только новые значения, не старые) и возвращает во VoiceTaskActionResult/
// VoiceEventActionResult, чтобы фронтенд мог откатить именно те поля,
// которые реально поменялись, кнопкой "Отменить" в чате (UNDO_WINDOW_MS —
// 30 секунд). Не Partial<CreateTaskInput/CreateEventInput> — те типизируют
// assigneeId/dueDate как string | undefined без null, а PATCH-эндпоинты
// трактуют null как "явно снять значение" (см. TasksService.update).
export interface TaskRevertPayload {
  title?: string;
  description?: string;
  assigneeId?: string | null;
  dueDate?: string | null;
  priority?: TaskPriority;
}
export interface EventRevertPayload {
  title?: string;
  description?: string;
  location?: string;
  startAt?: string;
  endAt?: string;
  allDay?: boolean;
}

// Итог выполнения ОДНОГО черновика (владелец 10.09.2026, аудит п. 2.11) —
// draft здесь тот же обогащённый черновик (assigneeName и т.п.), которым
// фронтенд уже умел пользоваться для текста в чате до перехода на
// серверное исполнение; ok/error/*Id/previous — новое, описывает, что
// реально произошло. taskId/eventId — id созданной/изменённой/удалённой
// записи (для create — новый, для update/delete — тот же, что
// targetTaskId/targetEventId в draft), null только при ok=false. previous
// заполнен только при action='update' и ok=true — иначе отменять нечего
// (create отменяется удалением по id, delete/ошибка — никак).
export interface VoiceTaskActionResult {
  type: 'task_action';
  draft: VoiceTaskActionDraft;
  ok: boolean;
  error: string | null;
  taskId: string | null;
  previous: TaskRevertPayload | null;
}
export interface VoiceEventActionResult {
  type: 'event_action';
  draft: VoiceEventActionDraft;
  ok: boolean;
  error: string | null;
  eventId: string | null;
  previous: EventRevertPayload | null;
}
export interface VoiceChatResult {
  type: 'chat';
  reply: string;
}

export type VoiceActionResult = VoiceTaskActionResult | VoiceEventActionResult | VoiceChatResult;

// results: массив, не одиночный результат (владелец 10.09.2026, найдено в
// проде: "удали встречу с Петром и создай новую на пятницу" в одной
// аудиозаписи — агент удалил встречу, а создание терялось, потому что
// схема инструмента физически могла вернуть только ОДНО действие за раз).
// Один элемент на каждую самостоятельную команду в транскрипте, в порядке
// произнесения — уже ВЫПОЛНЕННую сервером (см. комментарий у
// VoiceTaskActionDraft про п. 2.11), фронтенд только отображает; сбой
// одного действия (ok=false) не блокирует остальные. Для обычной
// однозадачной заметки — массив из одного элемента, как раньше.
export interface VoiceParseResponse {
  transcript: string;
  confidence: ConfidenceLevel;
  clarificationNeeded: boolean;
  clarificationReason: string | null;
  results: VoiceActionResult[];
}

// Память голосового диалога (аудит 10.09.2026, п. 2.9) — POST
// /voice/messages, фронтенд шлёт это, когда текст чат-пузыря ассистента
// становится окончательным (см. VoiceService.logAssistantMessage).
export interface LogVoiceMessageInput {
  text: string;
}

// --- Assistant Chat (Stage 2, владелец 15.09.2026) --------------------------
// Полноценный AI-чат (GET/POST /assistant/conversations[...]) — отдельная
// от voice-пути (VoiceParseResponse выше) история, объединение — отдельный,
// более поздний этап. task_card/event_card/tool_activity получили реальных
// producer'ов в Phase C (tool-calling); file по-прежнему без формы данных —
// ждёт Phase F (upload/generation). role/status/type — строчные строки;
// AssistantChatController переводит Prisma-enum'ы (заглавные) в них на
// границе HTTP (apps/api/src/assistant/assistant-response.mapper.ts) —
// AssistantChatService работает с Prisma-представлением, эти типы видит
// только клиент.
export type MessagePartType = 'markdown' | 'task_card' | 'event_card' | 'file' | 'tool_activity' | 'error';

export interface MarkdownPartData {
  content: string;
}

export interface ErrorPartData {
  message: string;
}

export interface TaskCardData {
  taskId: string;
  title: string;
  status: string;
  dueDate: string | null;
  assignee: { id: string; name: string } | null;
}

export interface EventCardData {
  eventId: string;
  title: string;
  startAt: string;
  endAt: string;
  location: string | null;
  participants: { id: string; name: string }[];
}

export interface ToolActivityData {
  label: string;
}

export interface MessagePart {
  id: string;
  type: MessagePartType;
  order: number;
  // file data пока не описана — нет producer'а до Phase F.
  data: MarkdownPartData | ErrorPartData | TaskCardData | EventCardData | ToolActivityData;
}

export type AssistantMessageRole = 'user' | 'assistant';
export type AssistantMessageStatus = 'pending' | 'streaming' | 'completed' | 'failed';

export interface ConversationMessage {
  id: string;
  conversationId: string;
  role: AssistantMessageRole;
  status: AssistantMessageStatus;
  clientRequestId: string | null;
  createdAt: string;
  updatedAt: string;
  parts: MessagePart[];
}

export interface ConversationSummary {
  id: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

// POST /assistant/conversations/:id/messages. clientRequestId — идемпотентность
// (Stage 2 §29): один и тот же id в повторной отправке (плохой интернет,
// двойной tap) не создаёт вторую пару сообщений на сервере.
export interface SendAssistantMessageInput {
  text: string;
  clientRequestId?: string;
}

export interface SendAssistantMessageResponse {
  userMessage: ConversationMessage;
  assistantMessage: ConversationMessage;
}

export interface GoogleCalendarStatus {
  connected: boolean;
  // Настроен ли OAuth-клиент (GoogleOAuthAppConfig, вводится владельцем в
  // личном кабинете) — не то же самое, что connected: без него кнопка
  // подключения всегда упадёт, UI показывает форму ввода вместо этого.
  configured: boolean;
  // clientId уже введён — показать в форме как "уже сохранено", без
  // повторного запроса секрета целиком (см. GoogleOAuthService.getPublicConfig).
  clientId?: string;
  googleAccountEmail?: string;
  connectedAt?: string;
  lastSyncAt?: string | null;
}

export interface SetGoogleOAuthConfigInput {
  clientId: string;
  clientSecret: string;
}

export interface LoginResponse {
  accessToken: string;
  user: {
    id: string;
    fullName: string;
    email: string;
    role: Role;
    isProfileAdmin: boolean;
  };
}
