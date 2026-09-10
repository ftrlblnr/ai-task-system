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
// Черновик эфемерный: бэкенд ничего не пишет в Task/Event, поля подобраны
// так, чтобы Mini App/веб собрали из них тело POST/PATCH/DELETE без доп.
// маппинга (см. CreateTaskInput/CreateEventInput выше).
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
// нового значения. Удаление (action='delete') ничего не удаляет само по
// себе — фронтенд обязан показать подтверждение (кнопки в чате) прежде чем
// звать DELETE.
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

export interface VoiceParseResponse {
  transcript: string;
  confidence: ConfidenceLevel;
  clarificationNeeded: boolean;
  clarificationReason: string | null;
  draft: VoiceDraft;
}

// Память голосового диалога (аудит 10.09.2026, п. 2.9) — POST
// /voice/messages, фронтенд шлёт это, когда текст чат-пузыря ассистента
// становится окончательным (см. VoiceService.logAssistantMessage).
export interface LogVoiceMessageInput {
  text: string;
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
