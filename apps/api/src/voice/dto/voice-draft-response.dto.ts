import { TaskPriority } from '@prisma/client';
import type { ResponseMessage } from '../../assistant/assistant-response.mapper';

// Ответ POST /voice/parse. Черновик разбирается и ВЫПОЛНЯЕТСЯ в одном и том
// же запросе (владелец 10.09.2026, аудит п. 2.11 — см. комментарий у
// VoiceParseResponse внизу файла); status=DRAFT из Task/Event сюда не
// задействован — это отдельная зарезервированная семантика Этапа 5 AI
// Routing Engine (см. README «Голосовой AI-агент»), не про этот эфемерный
// черновик разбора.
//
// task/event создание+редактирование+удаление объединены в ОДИН тип
// каждый (action: create/update/delete), а не в 7 отдельных веток
// (было: task/event/update_task/delete_task/update_event/delete_event) —
// владелец 09.09.2026: Anthropic отклоняет строгую tool-схему с "The
// compiled grammar is too large" при 7 крупных ветках анyOf, даже после
// того, как убрали все enum-списки реальных id (это была отдельная,
// более ранняя проблема — "too many parameters with union types" — тоже
// решена, но недостаточно само по себе). Меньше веток — меньше
// скомпилированная грамматика.
//
// Поля title/description/location — пустая строка "" означает "не
// упомянуто, не менять" при action='update', и одновременно "нет
// значения" при action='create' (для новой задачи/встречи это одно и то
// же — то и другое означает "поле остаётся пустым"). assigneeId/dueDate/
// priority/startAt/endAt/allDay — null означает то же самое ("не
// упомянуто"/"нет значения"), эти поля не переведены на пустую строку,
// т.к. у них нет естественного "пустого" представления как у строки.
// Голосовая ОЧИСТКА уже заполненного поля не поддерживается в этом заходе
// (осознанное упрощение) — только установка нового значения.
export interface VoiceTaskActionDraft {
  type: 'task_action';
  action: 'create' | 'update' | 'delete';
  // '' при action='create' — новой задачи ещё не существует.
  targetTaskId: string;
  // Название для текста подтверждения (update/delete) — для create это
  // то же самое, что title.
  targetTitle: string;
  title: string;
  description: string;
  assigneeId: string | null;
  assigneeName: string | null; // резолвит сервер, не поле схемы инструмента
  dueDate: string | null;
  priority: TaskPriority | null;
  // Заполнено, если диктовка начата со страницы встречи (владелец
  // 09.09.2026, /voice?meetingId=...) — сервер проставляет сам, только
  // при action='create'.
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
  // кого добавить.
  addParticipantIds: string[];
  addParticipantNames: string[]; // резолвит сервер
  removeParticipantIds: string[]; // имеет смысл только при action='update'
  removeParticipantNames: string[];
}

// Владелец 07.09.2026: не всё сказанное — попытка продиктовать задачу или
// событие. Раньше на вопрос/реплику/неразборчивую запись система всё равно
// создавала задачу-заглушку («Уточнить формулировку задачи») — ответить
// собеседнику было нечем, только замусорить список задач. type: 'chat' —
// отдельная ветка: ничего не создаётся/выполняется, ассистент просто
// отвечает текстом в чате.
export interface VoiceChatReply {
  type: 'chat';
  reply: string;
}

export type VoiceDraft = VoiceTaskActionDraft | VoiceEventActionDraft | VoiceChatReply;

// Зеркало packages/shared-types (проект дублирует типы api/web вручную,
// см. остальные dto в этой папке) — подробные комментарии там.
export interface TaskRevertPayload {
  title?: string;
  description?: string;
  assigneeId?: string | null;
  dueDate?: string | null;
  priority?: TaskPriority | null;
}
export interface EventRevertPayload {
  title?: string;
  description?: string;
  location?: string;
  startAt?: string;
  endAt?: string;
  allDay?: boolean;
}

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
// произнесения — уже ВЫПОЛНЕННую сервером (владелец 10.09.2026, аудит п.
// 2.11: раньше /voice/parse только возвращал черновик, а POST/PATCH/DELETE
// был отдельным запросом с фронтенда — при потере сети между ними
// Whisper+Claude уже оплачены, а задача не создана; удаление теперь тоже
// выполняется сразу, без дополнительного подтверждения кнопками — "по
// удалению давай доверять", сознательное решение владельца после
// практической проверки). Фронтенд только отображает; сбой одного
// действия (ok=false) не блокирует остальные.
export interface VoiceParseResponse {
  transcript: string;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  clarificationNeeded: boolean;
  clarificationReason: string | null;
  results: VoiceActionResult[];
  // Stage 2, Phase H — аддитивные поля: голос и текст теперь пишут в одну
  // ленту (Conversation/Message/MessagePart вместо отдельной VoiceMessage).
  // apps/web (отдельная страница /voice, не объединена с текстовым чатом —
  // его там просто нет) продолжает работать на полях выше, эти новые поля
  // не трогая. apps/miniapp (объединённый экран «Ассистент») добавляет
  // userMessage/assistantMessage в ту же ленту, что уже рендерит для текста
  // — тем же MessagePartRenderer, без изменений в нём.
  conversationId: string;
  userMessage: ResponseMessage;
  assistantMessage: ResponseMessage;
}
