# Задание: единый агент и поручения из встреч

> Документ для Claude Code. Лежит в `docs/AGENT_AND_MEETINGS.md`. Прочитай
> этот файл целиком, затем `CURRENT_STATE.md` (разделы «Voice pipeline»,
> «Assistant Chat», «Phase O», «Регресс Live», «Задача из чата»,
> «Регламенты»), затем `apps/web/AGENTS.md` и `apps/miniapp/AGENTS.md`
> (Next.js 16 — сверяйся с `node_modules/next/dist/docs/`, а не с памятью).
> Две части: **A — единый агент** (этапы A0–A4) и **B — поручения из
> встреч** (этапы B1–B5). Делай по порядку A0 → A4 → B1 → B5: часть B
> опирается на инструменты из A. После каждого этапа останавливайся,
> показывай результат и жди «ок». Связанные документы: `docs/ARMS_PLAN.md`,
> `docs/WEB_REDESIGN.md`.

## 0. Зачем

Руководитель должен одинаково управлять задачами и календарём текстом,
голосом, живым голосом и из Claude (MCP) — «перенеси Рустему срок на
пятницу и напиши ему почему» сейчас работает только голосом. И ни одно
поручение с совещания не должно теряться: сейчас после синхронизации Plaud
руководитель сам сопоставляет «Speaker N» с людьми и сам нажимает
«Поставить задачи».

## 1. Что сейчас (сверено с кодом `main` 32fb8d6, 28.10.2026 — перепроверь)

**Два «мозга» у ассистента.**
- Чат — `assistant/assistant-reply.service.ts` (`runReply`: Haiku 5.5,
  effort low, до 3 раундов инструментов; роутер на Opus за флагом
  `ASSISTANT_ROUTER`, по умолчанию выключен). Инструменты —
  `assistant/assistant-tools.service.ts` (21 шт.). Задачи только читаются
  (`get_tasks`: фильтр `all|overdue`, **первые 10**, без фильтра по
  исполнителю/сроку/тексту) и создаются (`create_task`,
  `create_task_from_meeting`, только руководство). Менять, переводить по
  статусам, комментировать, напоминать, удалять задачи и что-либо делать с
  событиями чат **не умеет**.
- Голос — `voice/voice.service.ts` + `voice/draft-extraction.service.ts`:
  Whisper → один forced tool-use (Haiku → эскалация на Opus при LOW/
  уточнении) → черновики `task_action`/`event_action`/`chat` → валидация
  (`validateTarget`, `validateReferences`, `resolveAssigneeMention`,
  `enforceEventRbac`) → **немедленное исполнение** (`executeTaskAction`/
  `executeEventAction`, create/update/delete без подтверждения — решение
  владельца 10.09.2026) + `UndoRecord` на 30 с. Информационный вопрос
  (`isInformationalTurn`) уходит в `AssistantReplyService.reply`. Контекст
  голоса — до 40 задач и 40 событий.
- Живой голос — `live/live.service.ts` `processDelegation` →
  `voice.parseTranscript` (тот же голосовой пайплайн без STT).
- Защита от повторного выполнения: голос — `VoiceExecution`
  (`claimAndRunDurable`); чат — `TaskFromMeetingExecution` +
  `Task.sourceExecutionId @unique` (`claimTaskExecution`), ключ
  `<userMessageId>:<writeToolCallIndex>`; список пишущих инструментов —
  `WRITE_TOOL_NAMES`/`isWriteTool` (от него зависят ключи и то, что
  регламенты получают только чтение — `routines/routine-catalog.ts`).
- Отмена: `POST /voice/undo {undoToken}`; токен приходит только в
  `VoiceParseResponse.results[i]`, клиенты сопоставляют `results[i]` с
  `assistantMessage.parts[i]` по индексу (web и miniapp
  `components/assistant/voice-controls.*`, `message-list.tsx`).
- Карточки: `assistant/assistant-render.ts` (`buildAssistantParts`,
  `toolCardParts`, `VOICE_CARD_TOOLS`), данные — `dto/message-part-data.dto.ts`
  и `packages/shared-types` (`TaskCardData`, `EventCardData`).
- MCP (`mcp/mcp-tools.ts`, `MCP_TOOL_TITLES`) — только чтение.
- Календарь: `calendar/events.service.ts` (create/update с `version`/remove,
  участники), поиск свободного времени —
  `calendar/calendar-availability.service.ts` `findSlots` (сейчас только
  через `POST /calendar/availability` и вкладку в web, ассистенту недоступен).

**Встречи.**
- `plaud/plaud-sync.service.ts` `syncItem`: создаёт/обновляет `Meeting`
  (`rawSummary` заморожена, `latestSummary` — свежая), сегменты расшифровки
  `MeetingSegment` (`applyTranscriptSegments`, сопоставление говорящих
  переносится между ресинками). Транскрипт может прийти позже саммари.
- Имена говорящих — вручную: web `app/meetings/[id]/page.tsx`
  (`SpeakerNamesSection`) → `PATCH /meetings/:id/speakers` →
  `MeetingsService.updateSpeakers` (Haiku склоняет имена в
  `enhancedSummary`, `resolveSegmentSpeakers` ставит
  `MeetingSegment.speakerEmployeeId`).
- Задачи — вручную: «Поставить задачи» → `components/task-extraction-modal.tsx`
  → `MeetingsService.extractTasks` → `MeetingTaskExtractionService`
  (модель `'claude-opus-5'` — устаревший id, effort low, **только саммари**,
  исполнитель — закрытый enum id) → черновики эфемерны →
  `createTasksFromMeeting`.
- `Task.aiConfidence` пишется, но нигде не выставляется; утренний дайджест
  (`tasks/daily-digest.cron.ts`) уже умеет показывать руководителю задачи с
  `LOW`.
- В Mini App встреч нет вообще.
- **Ошибка:** кнопка «Голосом» на странице встречи
  (`app/meetings/[id]/page.tsx:117`) ведёт на `/voice`, страница удалена
  коммитом 208afdb — 404 на проде.

**Не трогать по ходу:** ветка `feat/tone-triage` (тон в черновиках
«Разбора») ещё не влита — не конфликтует с этим заданием, но если её
вольют раньше, учитывай `SkillsService.toneFor`.

## 2. Правила

- Соглашения репозитория (`CURRENT_STATE.md`, `apps/*/CLAUDE.md`):
  комментарии на русском с «почему»; «LLM — не граница безопасности» —
  права, существование и принадлежность сущностей проверяет сервер, id от
  модели — только подсказка; безопасные коды ошибок наружу (как
  `TOOL_ERROR_MESSAGES`), полные — в лог.
- **Иерархия риска владельца:** задачи — низкий риск (исполнение сразу +
  отмена 30 с, как сейчас у голоса); календарь — средний (сразу + отмена,
  как сейчас у голоса); почта — **всегда** через подтверждение (не менять).
  Новых путей отправки писем это задание не добавляет.
- Каждый новый пишущий инструмент: в `WRITE_TOOL_NAMES`, с durable-ключом
  идемпотентности, через доменный сервис (`TasksService`/`EventsService`),
  никогда прямым `prisma.task.update` — RBAC, история, уведомления живут там.
- Каждая модельная операция — через `trackedCreate`/`aiUsage.record` со
  своим `feature` (виден в «Расходе ИИ»).
- Время — местное Asia/Almaty (`common/timezone.ts`: `withLocalOffset`,
  `nowInLocalTimezone`), модель пишет даты без смещения.
- Mini App и web — зеркала: общая логика в `packages/shared-types`, UI —
  в обоих приложениях.
- Проверка каждого этапа: `cd apps/api && npx jest --silent` (полный
  `tsc`/`eslint` api на VPS упирается в память — их вердикт даёт CI `gate`,
  локально — scoped `eslint` по изменённым файлам), `npx tsc --noEmit` и
  `npm run build` в `apps/web` и `apps/miniapp`, если они менялись.
  Перед сменой промпта или модели — `npm run eval:ai` (ходит в настоящие
  API, стоит денег — запускать вручную).
- В конце каждого этапа — раздел в `CURRENT_STATE.md`.

# Часть A. Единый агент

Цель: один агент (`AssistantReplyService.runReply`) обслуживает текст,
push-to-talk, живой голос, навыки и регламенты; голос перестаёт быть
отдельным мозгом и становится способом ввода.

## A.1 Инструменты задач

Новые инструменты в `assistant-tools.service.ts` (чистые билдеры схем и
форматтеры — в отдельном `assistant/task-tools.ts`, под тестом без ключа).

**`find_tasks`** (чтение, все роли — задачи видят все, владелец 20.10.2026):
- вход: `assigneeRawText?` (как прозвучало, сервер резолвит через
  `EmployeeResolverService`; `AMBIGUOUS`/`NOT_FOUND` — понятная модели
  ошибка с кандидатами), `creatorRawText?`, `mine?: 'assigned'|'created'`,
  `status?: TaskStatus[]` (по умолчанию открытые: всё, кроме DONE/
  CANCELLED), `overdue?`, `dueFrom?`/`dueTo?` (местное время), `query?`
  (подстрока в title/description), `sourceMeetingId?`, `limit?` (≤ 30,
  по умолчанию 15);
- выход: `items` (карточки `TaskCardData` + `priority`, `isOverdue`,
  `daysOverdue`), `totalCount` и **агрегаты по всей выборке, а не по срезу**:
  `byAssignee [{name, open, overdue}]`, `byStatus`. Счёт — запросами в БД
  (`count`/`groupBy`), не перебором `findAll()`;
- фильтрация — в `TasksService` новым методом `search(filter)` (Prisma
  `where`, `parentTaskId: null`), не в инструменте.

**`get_task`** (чтение): одна задача по id — описание, подзадачи,
последние 10 записей `TaskHistory`, последние 10 комментариев, источник.

**Пишущие** (все через `TasksService`, его RBAC — источник правды):
| Инструмент | Что | Кому выдаётся |
|---|---|---|
| `update_task` | title / description / `assigneeRawText` / dueDate / priority | всем (сервис пустит постановщика и руководство) |
| `set_task_status` | статус | всем (сервис: исполнитель — рабочие статусы, руководство — любые) |
| `comment_task` | комментарий от имени пользователя | всем |
| `remind_task` | `TasksService.remind` (Telegram исполнителю, раз в час) | всем (сервис проверит) |
| `delete_task` | удаление | всем (сервис проверит); только по прямой просьбе |
| `create_task` | уже есть | руководство (как сейчас) |

- Описания инструментов: вызывать только по прямой просьбе, цель —
  только id из `find_tasks`/`get_task`/`[shown_task]`/`[page_context]`;
  «перенеси на пятницу» без конкретной задачи — сначала найди и уточни.
- `ForbiddenException` из сервиса → `TASK_FORBIDDEN: <текст сервиса>`,
  `NotFoundException` → `TASK_NOT_FOUND` (модель объясняет пользователю).
- Существующий `get_tasks` оставить (на него ссылаются навыки
  `skill-catalog.ts` и сохранённые навыки пользователей), в описании —
  «для полного списка с фильтрами используй find_tasks». Системные навыки
  `/день`, `/просрочки`, `/к-встрече`, `/итоги-недели` перевести на
  `find_tasks` правкой `SYSTEM_SKILLS` (seed не трогает уже созданные —
  добавь в миграцию данных обновление инструкций **только** если
  `instructions` совпадают с прежним текстом seed дословно).

## A.2 Инструменты календаря (только руководство, `isManager`)

- **`find_events`** — события в диапазоне (`EventsService.findAll(owner,
  {from,to})`, по умолчанию сегодня + 7 дней), фильтр по подстроке и
  участнику; заменяет в описании `get_events` для конкретных дат
  (`get_events` оставить ради совместимости навыков).
- **`find_free_slots`** — `CalendarAvailabilityService.findSlots(ownerId,
  from, to, durationMinutes, maxResults)`; учитывает `CalendarPolicy`.
- **`create_event` / `update_event` / `delete_event`** — те же поля, что у
  голосового `event_action` (участники `addParticipantRawText[]`/
  `removeParticipantRawText[]` резолвятся сервером), исполнение — логикой,
  перенесённой из `executeEventAction` (A.4), `update` — с `version` только
  что прочитанного события (конфликт → `EVENT_CHANGED`, модель перечитывает).
- Владелец данных — сам пользователь (ADMIN работает со своим календарём,
  как сейчас у ассистента; `X-Act-As` в чат не тянуть).

## A.3 Исполнение, идемпотентность, отмена

- **Новая таблица `AgentActionExecution`** (обобщение
  `TaskFromMeetingExecution`, тот же claim-паттерн):
  `id, conversationId, dedupeKey, tool, status (CLAIMED|COMPLETED|FAILED),
  resultJson Json?, errorMessage?, createdAt, updatedAt`,
  `@@unique([conversationId, dedupeKey])`. Ключ —
  `<userMessageId>:<writeToolCallIndex>` (для голоса userMessageId =
  `VoiceExecution.id`, как уже делает `runParse`). Повтор с COMPLETED
  возвращает сохранённый `resultJson` без повторной мутации; свежий CLAIMED
  — `ALREADY_PROCESSING`; устаревший (> 60 с) CLAIMED без результата —
  **не** переисполнять вслепую: для update/status/comment/delete сравнить
  текущее состояние сущности с целевым (уже применено → COMPLETED, иначе
  повторить), для create — как сейчас (`sourceExecutionId`).
  `create_task`/`create_task_from_meeting` остаются на своей таблице —
  не переносить в этом задании.
- **Отмена для чата и голоса одинаково:** `createUndoRecord` вынести из
  `VoiceService` в общий `assistant/undo.service.ts` (вместе с откатом из
  `VoiceService.undo`); все пишущие инструменты задач и событий (кроме
  delete и comment/remind) создают `UndoRecord` и кладут в карточку
  `undoToken` + `undoExpiresAt`. **Сделано в A2 иначе:** откат остался в
  `VoiceService.undo` и `POST /voice/undo` (на нём сотни строк тестов);
  чат создаёт тот же `UndoRecord` (+ `conversationId`, куда писать
  «Отменено.»), откат статуса — через `updateStatus`. Перенос в
  `undo.service.ts` и `POST /assistant/undo` — в A4, вместе с голосом.
  `TaskCardData`/`EventCardData` получают
  необязательные `undoToken?: string | null`, `undoExpiresAt?: string | null`,
  `change?: { field, from, to }[]` (что изменилось — показать «срок: 25.10 →
  31.10»). Эндпоинт отката — новый `POST /assistant/undo {undoToken}`;
  `POST /voice/undo` оставить алиасом на тот же сервис.
- Клиенты (web и miniapp `message-list`/`assistant-message-part`): кнопка
  «Отменить» рендерится **из данных части** (`undoToken`, пока не истёк
  `undoExpiresAt` по часам сервера минус 2 с запаса), а не из
  `results[i]`. После отмены — тост и перезагрузка истории.
- Карточки: `toolCardParts` — `TASK_CARD`/`EVENT_CARD` для всех пишущих
  инструментов; `delete_*` — MARKDOWN «Удалил …»; `VOICE_CARD_TOOLS` —
  добавить новые пишущие. `toolActivityLabel` — подписи («Перенёс срок
  «…»», «Нашёл задачи: 37»). `SKILL_TOOL_LABELS` — подписи новых
  инструментов. `MCP_TOOL_TITLES` — добавить только `find_tasks`,
  `get_task`, `find_events`, `find_free_slots` (MCP остаётся только чтением).
- Аудит: `AI_TASK_UPDATE`, `AI_TASK_STATUS`, `AI_TASK_COMMENT`,
  `AI_TASK_REMIND`, `AI_TASK_DELETE`, `AI_EVENT_CREATE|UPDATE|DELETE` —
  id и изменённые поля, без текстов.
- `SYSTEM_PROMPT` (`assistant-reply.service.ts`): короткий блок про
  задачи/календарь — менять сразу по прямой просьбе, отмена 30 с, не
  выдумывать id, перед изменением «той задачи» без id — `find_tasks` и
  уточнение при нескольких кандидатах; удаление — только по прямому слову
  «удали». Промпт кэшируется — правь одним изменением.
- `MAX_TOOL_ROUNDS` чата поднять до 5 (найти → изменить → ответить
  занимает 2–3 раунда).

## A.4 Голос на едином агенте

- Флаг `VOICE_ENGINE=agent|legacy` (по умолчанию `legacy` до «ок»
  владельца после живой проверки, затем `agent`).
- В режиме `agent` `VoiceService.runParse` после STT (и для `parseTranscript`
  Live) **не** вызывает `DraftExtractionService`: транскрипт уходит в
  `AssistantReplyService.reply` с историей разговора, `[live_context]` и
  ключом `userMessageId = VoiceExecution.id`. Всё вокруг остаётся:
  `VoiceExecution` (статусы PROCESSING → EXECUTING перед вызовом агента →
  COMPLETED/NEEDS_RECONCILIATION), запись user/assistant-сообщений в ленту,
  метрики (`llmMs` вместо `llmFastMs/llmStrongMs`), аудит `TRANSCRIBE`,
  эхо-подсказка STT (`stt-echo.ts`).
- Ответ голоса — `buildAssistantParts` (текст + карточки). Поле
  `VoiceParseResponse.results` заполнять производно из `toolCalls`
  (`task_action`/`event_action` с `ok`, `taskId`/`eventId`, `undoToken`) —
  ради `toSpokenLiveReply` и обратной совместимости на один релиз; клиенты
  к этому моменту читают отмену из частей (A.3).
- Качество голоса: Haiku без эскалации может ошибаться на длинных
  командах. Эскалация в режиме `agent`: если модель в первом ответе не
  вызвала ни одного инструмента и не задала вопрос, а транскрипт содержит
  глагол действия (простая эвристика списком: «поставь, создай, перенеси,
  удали, назначь, поручи, запиши, напомни…») — повторить ход на Opus 5.5
  effort low. Проверить на eval, иначе убрать.
- `enforceEventRbac`-эквивалент: событийные инструменты сотруднику просто
  не выдаются (как `get_events` сейчас).
- `DraftExtractionService` не удалять до перевода флага по умолчанию;
  удаление — отдельный коммит после «ок».

## A.5 Проверочный набор

В `ai-eval/run-eval.ts` новая группа «агент» (≥ 12 случаев, на фейковых
инструментах — без БД, проверяется, какой инструмент и с какими аргументами
вызван): «перенеси Азамату срок по вентшахте на пятницу» → `find_tasks` →
`update_task(dueDate = пятница 18:00)`; «что у Ирины просрочено» →
`find_tasks(assignee, overdue)`; «закрой задачу про отчёт» при двух
кандидатах → вопрос, а не изменение; «найди час с Арманом на следующей
неделе» → `find_free_slots`; «поставь встречу с Арманом завтра в 15» →
`create_event`; «удали» без объекта → вопрос; «как поставить задачу на
Рустема, чтобы он завтра сходил в магазин» → `create_task` (инцидент
25.10.2026); информационный вопрос → без пишущих инструментов. Прогон
обязателен до и после A4.

# Часть B. Поручения из встреч

Цель: после записи совещания руководитель получает готовый список
поручений с исполнителями, сроками и цитатой-источником и утверждает его
одним нажатием.

## B.1 Модель данных (миграция, аддитивная)

```prisma
enum MeetingAnalysisTrigger { AUTO BUTTON }
enum MeetingAnalysisStatus { QUEUED RUNNING DONE FAILED SKIPPED }
enum MeetingProposalStatus { PROPOSED APPROVED REJECTED SUPERSEDED }

model MeetingAnalysisRun {
  id          String   @id @default(cuid())
  meetingId   String   // onDelete: Cascade
  trigger     MeetingAnalysisTrigger
  status      MeetingAnalysisStatus @default(QUEUED)
  // sha256(summary + transcriptHash): тот же вход не разбираем дважды.
  inputHash   String
  attempts    Int      @default(0)
  lockedAt    DateTime?
  notBefore   DateTime @default(now()) // ожидание расшифровки, см. B.2
  speakerSuggestions Json?   // [{label, employeeId|null, name, confidence, applied}]
  error       String?
  tokensIn    Int?
  tokensOut   Int?
  notifiedAt  DateTime?
  createdAt   DateTime @default(now())
  finishedAt  DateTime?
  @@unique([meetingId, inputHash])
  @@index([status, notBefore])
}

model MeetingProposal {
  id              String   @id @default(cuid())
  meetingId       String   // Cascade
  runId           String   // Cascade
  order           Int
  title           String
  description     String?
  assigneeId      String?  // SetNull
  assigneeRawText String?  // как прозвучало
  dueDate         DateTime?
  priority        TaskPriority?
  confidence      ConfidenceLevel
  sourceContext   String   // безопасно показать исполнителю
  sourceSegmentId String?  // SetNull
  sourceTimestamp String?
  similarTaskId   String?  // похоже на уже существующую задачу
  status          MeetingProposalStatus @default(PROPOSED)
  taskId          String?  @unique // созданная задача, SetNull
  version         Int      @default(1)
  decidedById     String?
  decidedAt       DateTime?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  @@index([meetingId, status])
}
```

Предложения — **отдельная таблица, не `Task` в статусе DRAFT**: черновик-
задача попала бы в общий список, канбан, дайджесты, счётчики пульта и
уведомления исполнителю.

## B.2 Постановка в очередь

- `PlaudSyncService.syncItem` после успешной записи встречи/сегментов
  вызывает `MeetingAnalysisService.enqueue(meetingId, 'AUTO')`
  (best-effort: ошибка очереди не роняет синк). Синк **не ждёт** модель.
- Правила `enqueue`: флаг `MEETING_AUTOPROCESS=on`; встреча из Plaud,
  владелец подключения — активный руководитель/администратор; саммари ≥
  300 символов; нет запуска с тем же `inputHash`; если расшифровки ещё нет —
  `notBefore = now + 30 мин` (Plaud часто дописывает её позже; пришла
  раньше — новый `inputHash`, прежний QUEUED-запуск без расшифровки →
  SKIPPED). Изменилось содержимое после DONE (новый `inputHash`) — новый
  запуск, прежние PROPOSED → SUPERSEDED (APPROVED/REJECTED не трогать).
- Ручной запуск: `POST /meetings/:id/analysis` (руководство,
  `Idempotency-Key`) — `BUTTON`, тот же воркер; 409, если уже идёт.
- Воркер `meeting-analysis-execution.service.ts`: `@Cron` 10 с, claim
  `FOR UPDATE SKIP LOCKED` (как `routine-run-execution.service.ts`),
  блокировка 15 мин, 2 попытки, один запуск за тик.

## B.3 Шаг 1 — говорящие

- Если у встречи уже есть `speakerNames` от человека — шаг пропускается,
  ручное сопоставление никогда не перезаписывается.
- Кандидаты: участники событий календаря владельца, пересекающих
  `meetingDate` ±30 мин (`EventsService.findBetween`), сам владелец,
  остальные активные сотрудники вторым списком; плюс `EmployeeAlias`.
- Вход модели (Haiku 5.5, `feature: meetings.auto-speakers`, strict tool
  `map_speakers`): по каждой метке — до 12 первых реплик с таймкодами
  (обрезка по символам), кандидаты, название встречи. Выход:
  `[{label, name|null, confidence}]`. Имя резолвится сервером через
  `EmployeeResolverService`; внешний участник — просто имя без сотрудника.
- Применение: если **все** метки HIGH и имена различны —
  `MeetingsService.updateSpeakers` (это же пересчитает `enhancedSummary` и
  сегменты), `applied: true`. Иначе — только `speakerSuggestions`, в UI
  «Похоже, Speaker 2 — Жандос Ахметов · Верно / Исправить».
- Нет сегментов расшифровки — шаг пропускается.

## B.4 Шаг 2 — извлечение поручений

- `MeetingTaskExtractionService` переработать (ручной путь из модалки
  использует ту же функцию):
  - модель `claude-opus-5-5`, effort low, max_tokens 16000,
    `feature: meetings.auto-extract` (ручной — `meetings.task-extraction`);
  - вход: актуальное саммари (`enhancedSummary ?? latestSummary ??
    rawSummary`) **и** расшифровка: строки `[segmentId] mm:ss Имя: текст`;
    длинная — окнами по ~40 тыс. символов с перекрытием 2 тыс.,
    результаты окон сливаются и дедуплицируются (нормализованный title +
    исполнитель);
  - выход: `title`, `description`, `assigneeRawText` (как в тексте — не
    закрытый enum id: резолвит сервер, неоднозначный → `assigneeId: null`
    и сохранённый `assigneeRawText`), `dueDate` (относительно **даты
    встречи**, без смещения → `withLocalOffset`; только день → 18:00),
    `priority|null`, `confidence`, `sourceContext` (1–2 предложения),
    `segmentId|null` (сервер проверяет принадлежность встрече, чужой/
    несуществующий → null);
  - правило в промпте прежнее: только явные поручения и договорённости,
    сомнение — не включать; плюс — обещания самого руководителя тоже
    поручения (исполнитель — он).
- Дедупликация с уже существующим: открытые задачи с этой встречи
  (`sourceMeetingId`) и открытые задачи того же исполнителя за 30 дней —
  совпадение по нормализованным словам title (Жаккар ≥ 0.6, функция под
  тестом) → `similarTaskId` (в UI «похоже на «…»», по умолчанию не
  выбрано).
- Результат пишется одной транзакцией: предложения + `status DONE`. Пусто —
  DONE без уведомления.

## B.5 Утверждение

- API (руководство; `X-Act-As` не нужен — встречи общие для руководства):
  - `GET /meetings/:id/proposals` — последнего запуска + статус запуска +
    `speakerSuggestions`;
  - `POST /meetings/:id/proposals/approve` `{ items: [{ id, version,
    title?, assigneeId?, dueDate?, priority? }] }`, `Idempotency-Key`
    обязателен. Для каждого: захват `status PROPOSED → APPROVED` с
    проверкой `version` (конфликт → пункт в ответе с `VERSION_CONFLICT`, не
    500), затем `TasksService.create` с `sourceMeetingId`,
    `sourceSegmentId`, `sourceTimestamp`, `sourceContext`, `aiConfidence =
    confidence`, `taskId` в предложение. Ошибка одного пункта не
    останавливает остальные (предложение возвращается в PROPOSED с
    ошибкой в ответе);
  - `POST /meetings/:id/proposals/reject` `{ ids }`;
  - `POST /meetings/:id/speakers/confirm` `{ labels }` — применить
    подсказки говорящих (через `updateSpeakers`).
  - Аудит: `AI_MEETING_AUTO_EXTRACT` (кол-во), `MEETING_PROPOSALS_APPROVED`,
    `MEETING_PROPOSALS_REJECTED`.
- **Уведомление** после DONE с ≥ 1 предложением — владельцу подключения
  Plaud в Telegram (`sendMessageWithResult`, `notifiedAt` в той же
  транзакции, что и проверка «ещё не уведомляли»): «Встреча «…» разобрана:
  6 поручений, у 4 есть исполнитель и срок. Проверить: <WEB_APP_URL>/meetings/<id>?review=1».
  Кнопки Telegram — не в этом задании (будет отдельное — двусторонний бот).
  Не использовать `startapp` Mini App: параметр занят приглашениями
  (`TelegramService.consumeInvite`).
- **Web** (`app/meetings/[id]/page.tsx`):
  - новая панель «Поручения» над «Задачи из встречи»: статус разбора
    («Разбираю запись…», «Ждёт расшифровку до 14:30», «Не удалось» +
    «Повторить»), строки предложений: чекбокс (по умолчанию выбраны все,
    кроме `similarTaskId` и `confidence LOW`), title (редактируемый),
    исполнитель (выпадающий список сотрудников; `assigneeRawText`
    подсказкой, если не сопоставлен), срок, чип уверенности, таймкод-
    цитата `sourceContext`, «похоже на «…»» ссылкой; внизу «Утвердить
    выбранные · N» (акцент) и «Отклонить остальные»;
  - `?review=1` — прокрутка к панели и фокус на кнопке;
  - подсказки говорящих — в `SpeakerNamesSection` («Верно» / поле имени);
  - «Поставить задачи» → переименовать в «Разобрать заново» (BUTTON-
    запуск), `TaskExtractionModal` удалить, когда панель покрывает её
    функции (отдельный коммит);
  - кнопка «Голосом» (404) убрана в A0: «Агент» в шапке (`PageHeader`)
    уже открывает панель с контекстом встречи, голос — микрофон панели.
  - На списке встреч (`app/meetings/page.tsx`) — чип «6 поручений ждут».
- **Mini App:** на «Сегодня» руководителя (`today/attention-stack.tsx`)
  — карточка «Встреча · поручения ждут» с «Проверить» → новый оверлей
  `components/meeting-proposals-overlay.tsx`: список с чекбоксами,
  исполнитель и срок (без правки текста), Главная кнопка Telegram
  «Утвердить · N» (`useMainButton`), «Назад» — `useBackButton`. Источник
  карточек — секция `meetings` в `GET /dashboard/overview`
  (`{ status, fetchedAt, pending: [{ meetingId, title, count }] }`, без
  модели). Бейдж «Встречи» в `GET /me/badges` (web-меню) — число встреч с
  ожидающими предложениями.
- **Ассистент** (после A): инструменты `get_meeting_proposals` (чтение) и
  `approve_meeting_proposals { meetingId, approveIds?, rejectIds?,
  edits? }` (пишущий, руководство, тот же сервис, ключ из
  `AgentActionExecution`) — «утверди все поручения с планёрки, кроме
  третьего, срок Жандосу — среда». Карточки созданных задач — как у
  `create_task`.
- Пульт web (`focus-section.tsx`, «Требует вас») — строка с чипом
  ВСТРЕЧА и кнопкой «Проверить».

## 3. Этапы

| Этап | Что | Готово, когда |
|---|---|---|
| A0 | Убрать кнопку «Голосом» (404; «Агент» в шапке уже есть). Прогон `eval:ai` — зафиксировать исходные результаты в `CURRENT_STATE.md` | на странице встречи нет ссылки на `/voice`, исходный eval записан |
| A1 | `TasksService.search`, `find_tasks`, `get_task`, перевод системных навыков, MCP-титулы | «что у Ирины просрочено» отвечает по всей базе с агрегатами; тесты фильтров и RBAC |
| A2 | `AgentActionExecution`, `undo.service.ts`, `POST /assistant/undo`, пишущие инструменты задач, карточки с изменениями и «Отменить» в web и Mini App из данных части | в чате текстом переносится срок, меняется статус, пишется комментарий, отмена работает 30 с; повтор хода не меняет задачу дважды (тест); регламенты по-прежнему без пишущих инструментов (тест) |
| A3 | `find_events`, `find_free_slots`, `create/update/delete_event` | встреча ставится и переносится из чата; сотруднику инструменты календаря не выдаются (тест); конфликт версии → понятная ошибка |
| A4 | Голос и Live на едином агенте за `VOICE_ENGINE`, производные `results`, eval-группа «агент» | при `agent` голос и Live делают всё, что раньше, eval не хуже A0; при `legacy` поведение прежнее |
| B1 | Миграция B.1, `MeetingAnalysisService.enqueue`, воркер, ручной запуск, хук в `PlaudSyncService` | новая запись Plaud ставит запуск; повторный синк того же содержимого — нет; ожидание расшифровки работает |
| B2 | Шаг «говорящие» (B.3) + подсказки в web | ручные имена не перезаписываются (тест); все HIGH — применяются сами |
| B3 | Новое извлечение (B.4): расшифровка, окна, `segmentId`, резолв исполнителя, дедуп | на реальной встрече поручения со ссылками на реплики; дубли существующих помечены |
| B4 | API утверждения, панель в web, уведомление в Telegram, чип на списке | из Telegram-ссылки руководитель утверждает поручения, задачи созданы с источником и таймкодом, исполнители получили обычное «Вам назначена задача» |
| B5 | Mini App (оверлей, «Сегодня», секция overview), бейдж, пульт, инструменты ассистента | всё утверждается с телефона и фразой в чате |

## 4. Тесты (минимум, jest на фейковом Prisma, как в соседних spec)

- `TasksService.search`: каждый фильтр, открытые по умолчанию, агрегаты по
  всей выборке, подзадачи не попадают.
- Пишущие инструменты: RBAC сервиса пробрасывается кодом; повтор с тем же
  ключом не мутирует; устаревший CLAIMED с уже применённым изменением →
  COMPLETED без повтора; отмена восстанавливает прежние поля и не
  срабатывает после `expiresAt`/второй раз.
- `isWriteTool` знает все новые пишущие; `routineTools` их отсекает.
- Голос `agent`: `VoiceExecution` проходит те же статусы; сбой записи
  истории после исполнения не превращается в ошибку (как Phase H.1).
- Встречи: `enqueue` (флаг, порог длины, `inputHash`, ожидание
  расшифровки, SUPERSEDED), чужой `segmentId` → null, резолв исполнителя
  (однозначный/неоднозначный), дедуп-функция, утверждение с конфликтом
  версии и с частичной ошибкой, уведомление ровно одно.

## 5. Чего не делать

- Не отправлять письма и не добавлять новых путей отправки — почта только
  через существующие планы с подтверждением.
- Не создавать задачи из встреч без утверждения руководителя — даже при
  HIGH-уверенности (автоматически применяются только имена говорящих).
- Не выдавать пишущие инструменты регламентам и MCP.
- Не использовать `Task.status = DRAFT` для предложений.
- Не трогать `Meeting.rawSummary` (раздел 8.1 ТЗ — неизменна).
- Не удалять `DraftExtractionService` и `POST /voice/undo` в этом задании.
- Не перезаписывать сопоставление говорящих, сделанное человеком.
