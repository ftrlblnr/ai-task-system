import { TaskPriority } from '@prisma/client';

// Ответ POST /voice/parse — эфемерный черновик, ничего не пишется в Task/Event
// (см. README «Голосовой AI-агент»: Task.status=DRAFT зарезервирован под
// Этап 5 AI Routing Engine, использовать его здесь означало бы влезть в
// чужую зарезервированную семантику).
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
// отдельная ветка: ничего не создаётся, ассистент просто отвечает текстом
// в чате (см. VoiceScreen — при этом типе confirmDraft вообще не вызывается).
export interface VoiceChatReply {
  type: 'chat';
  reply: string;
}

export type VoiceDraft = VoiceTaskActionDraft | VoiceEventActionDraft | VoiceChatReply;

// drafts: массив, не одиночный draft (владелец 10.09.2026, найдено в
// проде: "удали встречу с Петром и создай новую на пятницу" в одной
// аудиозаписи — агент удалил встречу, а создание потерялось, потому что
// схема инструмента физически могла вернуть только ОДНО действие за раз).
// Один элемент на каждую самостоятельную команду в транскрипте, в порядке
// произнесения — фронтенд выполняет их последовательно (см. VoiceScreen/
// voice/page.tsx), сбой одного действия не блокирует остальные. Для
// обычной однозадачной заметки — массив из одного элемента, как раньше.
export interface VoiceParseResponse {
  transcript: string;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  clarificationNeeded: boolean;
  clarificationReason: string | null;
  drafts: VoiceDraft[];
}
