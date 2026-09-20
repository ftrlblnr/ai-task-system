# CURRENT_STATE — фактическое состояние системы (20.09.2026)

Этот файл описывает, что в системе реально реализовано и как оно работает
сейчас, а не то, что запланировано (см. README для истории решений и планов).
Составлен как часть observability-этапа голосового пайплайна — источник
истины при дальнейшей оптимизации.

## Состав монорепозитория

```
apps/api        NestJS — единственный backend-процесс, вся бизнес-логика
apps/web        Next.js — десктоп-интерфейс руководителя
apps/miniapp    Next.js — Telegram Mini App (мобильный UX, свайп-режимы)
packages/shared-types  Общие TypeScript-типы, импортируются api/web/miniapp
infra/docker    docker-compose + Dockerfile для продакшена и локального Postgres
infra/nginx     Пример конфигурации системного nginx (реверс-прокси) на проде
```

Три деплоятся как три отдельных Docker-образа (`infra/docker/docker-compose.prod.yml`),
собираются через GitHub Actions (`.github/workflows/build-and-push.yml`) и
публикуются в `ghcr.io`.

## PostgreSQL / Prisma

Один Prisma-клиент (`apps/api/prisma/schema.prisma`), единственный
источник схемы. Основные модели (по факту в схеме сейчас):

- `Employee`, `Position`, `Competency`/`EmployeeCompetency` — сотрудники,
  должности, компетенции.
- `TaskProfile`/`TaskProfileCompetency` — профили соответствия задачи
  требуемым компетенциям (задел под будущий AI-подбор исполнителя).
- `Task`, `TaskWatcher`, `TaskComment`, `TaskAttachment`, `TaskHistory` —
  задачи, наблюдатели, комментарии, вложения, история изменений полей.
- `Meeting` — встречи/протоколы (транскрипт+саммари).
- `Event`, `EventParticipant`, `GoogleCalendarConnection`,
  `GoogleOAuthAppConfig` — личный календарь руководителя + участники
  встреч + двусторонняя синхронизация с Google Calendar.
- `PlaudConnection` — OAuth-подключение к Plaud для автосинхронизации
  саммари встреч.
- `TelegramInvite`, `PasswordResetToken` — одноразовые токены с TTL и
  хранением только хэша.
- `AuditLog` — best-effort журнал действий (раздел 15 ТЗ).

Миграции — `prisma migrate deploy` при каждом старте контейнера `api`
(идемпотентно, без интерактивных вопросов).

## Tasks

`apps/api/src/tasks/` — канбан-задачи с RBAC на уровне сервиса (не только
контроллера): ставить задачу может любой сотрудник кому угодно (включая
руководителю), редактировать — постановщик или руководитель, переводить
между рабочими статусами — только исполнитель. Отдельное правило: задача с
`sourceMeetingId` (поставлена по итогам встречи) может быть создана только
`OWNER` — проверка внутри `TasksService.create`, так как зависит от тела
запроса. `TaskHistory` пишется на каждое изменение отслеживаемых полей
(title/description/status/priority/assigneeId/dueDate/taskProfileId) и
отображается на карточке задачи в обоих фронтендах. Есть наблюдатели
(`TaskWatcher`) с уведомлением в Telegram. Ежедневный дайджест и cron,
помечающий просроченные задачи `OVERDUE` (`daily-digest.cron.ts`), считают
границы дня в локальном времени компании (`common/timezone.ts`), а не в UTC.

## Employees / Competencies

`apps/api/src/employees/`, `apps/api/src/competencies/`,
`apps/api/src/positions/`. Полный профиль сотрудника (email, telegram,
статус, компетенции) видит только `OWNER`; сотрудникам отдаётся `{id,
fullName}` — этого достаточно, чтобы выбрать исполнителя. Последнего
`OWNER` в системе разжаловать нельзя (проверка в `EmployeesService.update`).
Компетенции — единственный профиль соответствия (отдельная сущность
"зона ответственности" была намеренно упразднена владельцем).

## Calendar / Google Calendar sync

`apps/api/src/calendar/` — личный календарь руководителя (`Event`), весь
модуль закрыт на `Role.OWNER` (кроме `google/callback` и `google/webhook`,
которые дёргает сам Google без нашего Bearer-токена — вынесены в отдельный
`GoogleCalendarPublicController`). Двусторонняя синхронизация с Google:

- Push из Google → нас: `events.watch()`-канал + `POST
  /calendar/google/webhook`, продлевается кроном ежедневно; фоновый pull
  каждые 15 минут как подстраховка от пропущенного webhook. Инкрементально
  по `syncToken`, полный ресинк при `410 GONE`.
- Push из нас → Google: best-effort, `If-Match: googleEtag` для защиты от
  гонки конкурентных изменений.
- Конфликты — last-write-wins по времени последнего изменения (единственный
  реальный редактор с обеих сторон — руководитель, полноценный merge
  избыточен).
- Refresh-токен Google хранится зашифрованным (`SecretBoxService`,
  AES-256-GCM).

`EventParticipant` — участники встречи (структурная сущность, тот же
паттерн, что `TaskWatcher` у задач), с уведомлением в Telegram при
добавлении. CRUD участников — `POST/DELETE events/:id/participants`.

## Meetings / Plaud

`apps/api/src/meetings/` — хранит `rawTranscript`/`rawSummary` (неизменны)
и `enhancedTranscript`/`enhancedSummary` (заготовка под будущую AI-обработку,
пока не заполняется). Видно только `OWNER`. `Task.sourceMeetingId` +
`sourceContext` дают исполнителю безопасный curated-контекст происхождения
задачи без доступа к самому протоколу.

`apps/api/src/plaud/` — OAuth-подключение к Plaud (`PlaudOAuthController`,
только `OWNER`) и автосинхронизация саммари (`PlaudSyncService`,
`PlaudSyncCron`): импортирует `auto_sum_note`, транскрипт из Plaud
сознательно не переносится. Курсор — `created_at` последней импортированной
записи (у Plaud нет `syncToken`, список отдаётся newest-first). Это уже
работающая автоматизация, а не только ручная загрузка — ручная загрузка
(`/meetings/new`) остаётся как альтернативный путь.

## Voice pipeline (голосовой AI-агент)

Реализован и работает в обоих фронтендах (`apps/web/src/app/voice/page.tsx`,
`apps/miniapp/src/components/voice-screen.tsx`) — не только спроектирован.

**Поток одного голосового запроса** (от нажатия записи до результата в чате):

1. Фронтенд записывает аудио (`MediaRecorder`, webm/opus), по остановке
   записи отправляет `multipart/form-data` на `POST /voice/parse`
   (опционально с `meetingId`, если диктовка идёт со страницы встречи).
2. `VoiceService.parse()` параллельно:
   - расшифровывает аудио через `WhisperService` (OpenAI `whisper-1`,
     `language: 'ru'` фиксирован, не auto-detect);
   - собирает контекст одним внутренним `Promise.all`: видимые сотруднику
     задачи (`TasksService.findAll`), видимые события календаря (только для
     `OWNER`), активные сотрудники, память диалога (последние ≤20 реплик из
     общего разговора сотрудника за последние ≤3 часа — `Message`/
     `MessagePart` объединённой ленты, см. Phase H ниже; до 20.09.2026
     читалось из отдельной `VoiceMessage`), и — если диктовка со страницы
     встречи — саммари этой встречи.
   Обе ветки (STT и БД-контекст) выполняются конкурентно, каждая со своим
   таймером (см. раздел "Метрики" ниже) — расшифровка не ждёт БД и наоборот.
3. Собранный контекст (задачи/события/сотрудники/история/саммари встречи)
   и транскрипт уходят в `DraftExtractionService.extract()` — forced
   tool-use вызов Anthropic Claude по каскаду: сначала `claude-haiku-4-5`
   (дёшево и быстро), и только если `confidence === 'LOW'` или модель сама
   попросила уточнение (`clarificationNeeded`) — повторный вызов
   `claude-opus-5` с тем же контекстом. Каскад строго последовательный (не
   параллельный) — в худшем случае это сумма времени обеих моделей.
4. Модель возвращает от 0 до `MAX_DRAFTS_PER_NOTE` черновиков одного из
   трёх видов: `task_action` (create/update/delete), `event_action`
   (create/update/delete, включая добавление/снятие участников), `chat`
   (уточняющий вопрос или пояснение). Один транскрипт может содержать
   несколько независимых команд ("удали встречу с Петром и создай новую на
   пятницу").
5. Каждый черновик проходит валидацию в `VoiceService` (не в промпте —
   промпт не граница безопасности для голосового ввода):
   `validateTarget` (targetTaskId/targetEventId должны быть из реально
   показанного модели списка, иначе → chat-уточнение) →
   `validateEventCreateCompleteness` (startAt обязателен на create) →
   `validateReferences` (невалидные id сотрудников/участников
   отфильтровываются, не роняют запрос) → `attachAssigneeName`/
   `attachSourceMeeting` → `enforceEventRbac` (жёсткая граница: событие от
   не-`OWNER` принудительно превращается в задачу или в отказ — календарь
   закрыт на `OWNER` на уровне контроллера, промпт этого не обеспечивает).
6. **Выполнение — сразу здесь же, в том же HTTP-запросе**, не отдельным
   POST/PATCH/DELETE с фронтенда: `executeTaskAction`/`executeEventAction`
   вызывают напрямую те же `TasksService`/`EventsService`, что и обычные
   REST-эндпоинты (та же RBAC-проверка, не задвоена). Порядок — строго
   последовательный (не `Promise.all`), потому что порядок команд в одном
   транскрипте имеет смысл, и сбой одного действия не должен прерывать
   остальные.
   - **Удаление задачи/встречи выполняется немедленно, без подтверждения**
     — осознанное решение владельца (10.09.2026, "по удалению давай
     доверять", после практической проверки). Отмены (undo) для удаления
     нет — только для create/update, в 30-секундном окне на фронтенде.
   - Создание/редактирование — тоже без подтверждения, с undo-окном.
7. Ответ (`VoiceParseResponse.results: VoiceActionResult[]`) — уже
   выполненные результаты, не черновики. Фронтенд рендерит их сразу в
   чат-пузыри, без дополнительного round-trip.
8. **С Phase H (20.09.2026)** реплика пользователя и ответ ассистента
   пишутся сервером в ту же ленту, что и текстовый чат — один `Message`
   (USER, transcript) + один `Message` (ASSISTANT, `MessagePart` на каждый
   элемент `results`: `TASK_CARD`/`EVENT_CARD` для create/update,
   MARKDOWN-текст для delete/chat-уточнения, `ERROR` для сбоя), см. раздел
   "Unified Voice Integration" ниже. Ответ дополнительно несёт
   `conversationId`/`userMessage`/`assistantMessage` — аддитивные поля,
   `apps/web`'s отдельная страница `/voice` их не использует и продолжает
   работать на прежних `transcript`/`results`.

**Метрики этого пайплайна теперь измеряются отдельно** (observability-этап,
15.09.2026) — см. раздел "Метрики и логирование" ниже.

## Anthropic / OpenAI интеграции

- **OpenAI** (`apps/api/src/voice/whisper.service.ts`) — только STT,
  модель `whisper-1`, `response_format: 'verbose_json'` (нужен для
  `audioDurationMs`, см. ниже), язык фиксирован `ru`.
- **Anthropic** (`apps/api/src/voice/draft-extraction.service.ts`) —
  единственное место использования Claude в системе, ровно один forced
  tool-use вызов на попытку (не агентный луп, без Tool Runner). Каскад
  `claude-haiku-4-5-20251001` → `claude-opus-5` (см. выше). Ключи
  (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`) читаются лениво при первом вызове
  сервиса, а не в конструкторе — отсутствие ключа роняет только конкретную
  функцию, не весь процесс.

## Assistant Chat (Stage 2, Phases A–H) — текстовый и голосовой AI-чат

**С Phase H (20.09.2026, `apps/miniapp` only)** это уже не отдельный от
голоса путь: `VoiceService`/`/voice/parse` сохраняет свой собственный
движок исполнения (`DraftExtractionService`, автономные мутации без
подтверждения — см. голосовой пайплайн выше), но пишет результат в ту же
ленту (`Conversation`/`Message`/`MessagePart`), что и текстовый чат.
Единственная вкладка «Ассистент» в `apps/miniapp` — микрофон встроен в
composer, отдельной вкладки «Голос» больше нет (см. подробности в разделе
"Unified Voice Integration" ниже). `apps/web` — отдельная десктоп-страница
`/voice` с диктовкой со страницы встречи — не объединялась (там никогда не
было текстового AI-чата, объединять нечего), продолжает работать как
раньше через тот же `/voice/parse`.

**Модель данных** (`apps/api/prisma/schema.prisma`): `Conversation` (один
на сотрудника — MVP лениво создаёт первый при первом обращении,
`AssistantChatService.listConversations`) → `Message` (`role`: USER/
ASSISTANT, `status`: PENDING/STREAMING/COMPLETED/FAILED,
`clientRequestId` уникален в паре с `conversationId` — идемпотентность
повторной отправки) → `MessagePart` (MARKDOWN/TASK_CARD/EVENT_CARD/FILE/
TOOL_ACTIVITY/ERROR, упорядочены `order`). `Message.replyToMessageId` —
явная self-relation FK на исходное user-сообщение (добавлено Phase F.1,
16.09.2026 — раньше пара user↔assistant искалась по `createdAt`, что не
гарантировало правильное сопоставление при почти одновременных запросах
с разных устройств).

**Backend** (`apps/api/src/assistant/`):
- `AssistantChatService.sendMessage`/`streamMessage` — одна и та же
  бизнес-логика (`AssistantReplyService.runReply`) поверх Anthropic,
  просто разный способ показать прогресс. `streamMessage` — SSE поверх
  POST (не `EventSource`, ему нужен GET без тела) с событиями
  `message.started`/`part.started`/`part.delta`/`tool.started`/
  `tool.completed`/`part.completed`/`message.completed`/`message.failed`
  (`dto/stream-event.dto.ts` — публичный контракт с lowercase-строками,
  мапится из внутреннего `InternalStreamEvent` на границе контроллера, тот
  же приём, что `assistant-response.mapper.ts` для non-streaming ответа).
  Обрыв клиентского соединения (`res.on('close')`) реально прерывает
  запрос к Anthropic через `AbortController`.
- Идемпотентность — тот же `clientRequestId` в том же `Conversation`
  находит существующую пару (`findExistingPair`, ищет через
  `replyToMessageId`) и коротко замыкает **только** на `COMPLETED`; при
  `FAILED` реально повторяет попытку через `update` той же строки, не
  создаёт вторую пару.
- История для модели (`loadHistory`) явно исключает само текущее
  user-сообщение (Phase F.1 — раньше при retry текущий вопрос уже был в
  БД к моменту загрузки истории и попадал в неё, а `runReply` добавлял
  тот же текст ещё раз отдельным элементом — модель видела вопрос дважды)
  и сериализует **все** типы частей, не только MARKDOWN
  (`serializeMessageForModelContext`) — карточки задач/событий и файлы,
  показанные пользователю, видны модели в следующих репликах компактным
  текстом (`[shown_task]\nid=...\ntitle=...\nstatus=...` и т.п.), не сырым
  JSON `MessagePart.data`.
- Tool-calling (`AssistantToolsService`) — только чтение (`get_tasks`,
  `get_events`), RBAC на уровне видимости инструмента (`get_events` не
  предлагается модели не-OWNER, а не отклоняется постфактум). Ошибки
  инструмента логируются полностью на сервере, наружу (в `tool_result`
  для Anthropic) уходит только безопасный код (`TASK_LOOKUP_FAILED`/
  `CALENDAR_LOOKUP_FAILED`) без `err.message` (Phase F.1, 16.09.2026).
- Наблюдаемость — лог-строка `AssistantChatService` на каждый запрос:
  `chatRequestMs` (полное время), `toolExecutionMs` (сумма времени всех
  вызовов инструментов), `timeToFirstTokenMs` (только streaming — время
  до первого `text-delta`).

**Файлы/вложения** (`apps/api/src/files/`, Phase F/F.1): загрузка через
`POST /files/upload`, allowlist MIME-типов (`upload-file.dto.ts`), лимит
20MB. Реальные байты файла сверяются с заявленным MIME по сигнатуре
(`file-signature.ts` — без внешних зависимостей: PDF/PNG/JPEG/GIF/WEBP по
позитивной сигнатуре, DOCX/XLSX только как «это ZIP-контейнер», без
глубокого разбора OOXML-структуры — осознанное ограничение; TXT/CSV без
надёжной сигнатуры отклоняются, только если байты похожи на исполняемый
файл Windows PE/Linux ELF). Хранилище — за интерфейсом `FileStorage`
(DI-токен `FILE_STORAGE`, сейчас единственная реализация —
`LocalFileStorageService`, локальная файловая система, путь из
`FILE_UPLOAD_DIR`). Загруженный, но так и не отправленный в сообщении
файл (`messageId === null`) можно снять вручную (`DELETE /files/:id`,
только для не прикреплённых своих файлов) или он удалится сам —
`FilesCleanupCron` (`@Cron(EVERY_HOUR)`) чистит такие осиротевшие
загрузки старше 24 часов с диска и из БД.

**Frontend** (`apps/miniapp/src/components/assistant-screen.tsx`) —
история подгружается с сервера при каждом возврате на вкладку (не
localStorage — второе устройство/долгое отсутствие видят ту же
переписку). Автоскролл при новых сообщениях подавляется, если
пользователь сам пролистал историю вверх во время долгого стрима
(`isNearBottomRef`), в этом случае показывается кнопка «↓ Новые
сообщения». Рендер живого текста стрима троттлится через
`requestAnimationFrame` (не на каждый `text-delta`-чанк). Фронтенд
зеркалит бэкенд-лимиты (`MAX_ATTACHMENTS = 10`, `MAX_TEXT_LENGTH = 4000`)
и `accept` на `<input type=file>` — подсказка UI, не замена серверной
проверке.

**Генерация файлов** (Phase G, 16.09.2026) — третий tool,
`export_tasks_xlsx` (`AssistantToolsService`, `apps/api/src/assistant/
task-export.ts`): пользователь просит выгрузить задачи файлом, модель
вызывает инструмент, `TasksService.findAll` (тот же источник, что
`get_tasks`) → `.xlsx` через `exceljs` → `FilesService.createGenerated`
(источник `FileArtifactSource.GENERATED`, поле, зарезервированное ещё в
Phase A) → обычный `FILE` `MessagePart`, тот же рендер/скачивание, что и
пользовательские вложения (Phase F), без изменений на фронте. В отличие
от карточек `get_tasks`/`get_events`, экспорт **не** обрезан до 10 —
файл содержит все видимые пользователю задачи (`EMPLOYEE` — свои,
`OWNER` — все). Файл, сформированный инструментом, но не долинкованный к
сообщению (ответ Anthropic упал уже после вызова инструмента) — тот же
`FilesCleanupCron`, что и обычный orphan upload, отдельной логики для
`GENERATED`-файлов нет.

**Files + Chat concurrency (Phase F.2, 17.09.2026)** — второй
стабилизационный заход, поверх уже сделанного в Phase F.1:
- **Current-turn attachments** — раньше "посмотри этот документ" +
  report.pdf модель видела буквально как "посмотри этот документ", без
  единого упоминания файла: `dto.attachmentIds` попадали в
  `MessagePart`/историю, но не в ТЕКУЩИЙ запрос к Anthropic.
  `serializeCurrentUserTurn` (`assistant-chat.service.ts`) добавляет
  компактный тег `[attached_file]\nid=...\nname=...\nmimeType=...\nsize=...`
  к тексту текущего сообщения — только метаданные, содержимое файла
  по-прежнему не читается и не передаётся. Отдельный тег от `[file]` из
  history (`serializeMessageForModelContext`) — оба входят в защиту от
  утечки формата в ответ модели (см. ниже).
- **Валидация файлов теперь и внутри `FilesService`**, не только на
  `FileInterceptor` контроллера — size/MIME-allowlist/расширение↔MIME
  проверяются в `upload()` напрямую, обход HTTP (гипотетический прямой
  вызов сервиса) больше не пропускает эти проверки.
- **DOCX/XLSX теперь проверяются как настоящий OOXML**, не просто "это
  ZIP": `file-signature.ts` читает central directory ZIP (без внешней
  библиотеки — только имена записей, не распаковка) и требует
  `[Content_Types].xml` + `word/`-запись (DOCX) или `xl/`-запись (XLSX).
  Произвольный `.zip`, переименованный в `.docx`/`.xlsx`, больше не
  проходит.
- **Компенсация storage/DB** — `FilesService.upload`/`createGenerated`:
  сбой `prisma.fileArtifact.create()` после успешного `storage.save()`
  теперь откатывает физический файл (`storage.delete`), не оставляет
  orphan на диске без единой ссылающейся записи в БД.
- **`Message.replyToMessageId` теперь `@unique`** — бизнес-правило "один
  assistant-ответ на одно user-сообщение" гарантирует сама БД. Два
  одновременных запроса с одним `clientRequestId` (гонка на
  `findExistingPair` → оба "не найдено") больше не падают с P2002 —
  `createUserMessageIdempotent`/`createAssistantMessageIdempotent`
  перехватывают unique-constraint-конфликт и переиспользуют строку
  победителя.
- **`FileStorage` — provider-neutral**: `getStream()` возвращает `Readable`
  (не `fs.ReadStream`), `storageProvider` берётся из `storage.provider`
  (не хардкод `'local'` в `FilesService`) — замена на S3/MinIO не
  потребует трогать `FilesService`.
- **`message.started` несёт авторитетное `userMessage`** — фронтенд
  заменяет свой optimistic-бабл сразу на этом событии, а не ждёт
  `message.completed`/полный refresh.
- **Недоступный attachment — явная ошибка**, не тихий пропуск: чужой/
  несуществующий/удалённый `attachmentId` отклоняет всю отправку с общим
  текстом (не раскрывает, какой именно случай), а не молча исключает
  файл из сообщения.
- **`extractText` склеивает все `TextBlock`** от Anthropic, не только
  первый через `.find()`.

**Unified Voice Integration (Phase H, 20.09.2026, `apps/miniapp` only)**:
- **Схема** — модель `VoiceMessage`/enum `VoiceMessageRole` удалены
  (миграция `drop_voice_message_unify_conversation`), голос читает/пишет
  `Conversation`/`Message`/`MessagePart` напрямую. `VoiceMessage` никогда
  не рендерилась ни на одном фронтенде (оба — `apps/miniapp` и `apps/web`
  — держали видимую историю только в `localStorage`) — разовый сброс
  3-часовой памяти диалога на момент деплоя, не потеря видимой истории.
- **`VoiceService.parse()`** резолвит разговор через новый
  `AssistantChatService.getOrCreatePrimaryConversation` (экспортирован из
  `AssistantModule` специально для этого), пишет один `Message` (USER,
  transcript) + один `Message` (ASSISTANT) с частями по числу элементов
  `results`, в том же порядке (`voice-render.ts`,
  `buildVoiceAssistantParts`): create/update → `TASK_CARD`/`EVENT_CARD` из
  свежей сущности (`executeTaskAction`/`executeEventAction` теперь
  захватывают возврат `TasksService.update`/довозвращают `EventsService`
  после участников, раньше отбрасывали); delete → MARKDOWN-текст (карточку
  показывать нечего); `chat` → MARKDOWN; `ok=false` → `ERROR`.
  `resolveClarificationReason` — общий гейт на `clarificationNeeded` для
  публичного поля ответа и для отдельной MARKDOWN-части в конце.
- **`toTaskCardData`/`toEventCardData`** вынесены в отдельные
  экспортируемые функции (`assistant-tools.service.ts`) — одна и та же
  карточка для "модель посмотрела" (`get_tasks`/`get_events`) и "только
  что создано/изменено голосом". `serializeMessageForModelContext`
  экспортирован из `AssistantChatService`, голос переиспользует его для
  памяти диалога вместо собственной сериализации.
  `stripLeakedContextMarkers` теперь применяется и к голосовым
  `chat.reply`/`clarificationReason` — с общей историей голосовой ответ
  тоже может увидеть `[shown_task]`/`[file]`-метки текстового чата в том
  же разговоре.
- **`VoiceService.logAssistantMessage()`** (`POST /voice/messages`,
  контракт не изменился) пишет отдельное ("standalone", без
  `replyToMessageId`) assistant-сообщение в ту же ленту вместо строки
  `VoiceMessage` — подтверждения undo ("Отменено.") теперь реально видимы
  в истории, а не только эфемерная память LLM.
- **`apps/miniapp`**: `voice-screen.tsx` удалён, вкладка "Голос" убрана из
  `app/page.tsx`. `assistant-screen.tsx` — кнопка микрофона в том же слоте,
  что кнопка отправки (заменяет её, когда поле ввода пустое — как в
  обычных мессенджерах); полноэкранная сфера/кольца с амплитудой из
  прежнего `voice-screen.tsx` сознательно не перенесены. "Отменить" для
  голосового create/update — временная (не персистентная, как и раньше)
  кнопка под нужной частью сообщения, `results[i]` зипуется с
  `assistantMessage.parts[i]` по индексу; "Открыть" для задач не
  дублируется отдельной кнопкой — уже есть в `TaskCardView`.
- **`apps/web`** (`app/voice/page.tsx`) не тронут — там никогда не было
  текстового AI-чата, объединять нечего; `VoiceParseResponse` получил
  только аддитивные поля (`conversationId`/`userMessage`/
  `assistantMessage`), которые эта страница просто не читает.
- **Живой прогон (20.09.2026, реальные Whisper+Claude)** нашёл и закрыл
  реальный баг: `clarificationReason` в схеме инструмента
  (`draft-extraction.service.ts`) — обычная строка, не nullable (Anthropic
  не поддерживает nullable-строки в строгой схеме), модель кладёт туда
  буквальный текст `"null"`, когда сказать нечего. Без гейта на
  `clarificationNeeded` (который был у прежнего фронтенда, но потерялся
  при переносе на бэкенд) каждый обычный голосовой ответ показывал бы
  лишний пузырь с текстом "null" — исправлено `resolveClarificationReason`,
  закреплено регрессионными тестами.

**Известные ограничения этого этапа** (сознательно не сделано, см. планы
стабилизации от 16.09.2026, 17.09.2026 и генерации файлов от 16.09.2026):
- Нет frontend-тестовой инфраструктуры вообще (ни `apps/miniapp`, ни
  `apps/web` не используют jest/vitest/Testing Library — только
  `apps/api`) — заведение такой инфраструктуры отложено как отдельное
  архитектурное решение, не строчка в стабилизационном патче.
- Живой прогон Phase G/F.2 поймал, что модель иногда дословно копирует
  служебный формат истории (`[shown_task]`/`[shown_event]`/`[file]`/
  `[attached_file]` с `key=value`) в собственный текстовый ответ —
  инструкция в
  `SYSTEM_PROMPT` одна не всегда надёжна для быстрой модели. Исправлено
  детерминированной зачисткой на выходе (`stripLeakedContextMarkers`,
  `assistant-reply.service.ts`) — гарантирует чистоту **сохранённого**
  сообщения; во время самого стриминга (`streamMessage`) утечка теоретически
  может на долю секунды промелькнуть в `part.delta`, прежде чем финальный
  `message.completed` перезапишет её очищенным текстом — не устранено
  (потребовало бы буферизации всего ответа перед показом, что противоречит
  смыслу стриминга).
- Модель не гарантированно вызывает `export_tasks_xlsx` заново при
  дословном повторе одного и того же запроса на экспорт несколько раз
  подряд в одном разговоре — иногда отвечает "файл готов" из памяти
  предыдущего ответа, не прикладывая новый `FILE`-part. Усилено
  инструкцией в `SYSTEM_PROMPT` (заметно снизило частоту, не устранило
  полностью) — узкий вырожденный случай (буквальный повтор одной и той же
  просьбы), не типичный сценарий использования; принудительный
  `tool_choice` для этого намеренно не заводился — это уже другой,
  более инвазивный механизм диспетчеризации инструментов.
- **Exactly-once execution не гарантирован** (P0, найдено внешним
  аудитом 20.09.2026, не в рамках Phase H) — идемпотентность
  (`conversationId`+`clientRequestId`/`replyToMessageId` unique,
  P2002-recovery) защищает от дублей СТРОК в БД, но не от двух
  конкурентных запросов с одним `clientRequestId`, оба прошедших
  `findExistingPair` до того, как первый успел записать
  assistant-сообщение — в этом окне оба вызовут `this.reply.reply(...)`
  (реальный запрос к Anthropic + инструменты) по-настоящему дважды.
  Сегодня инструменты только читают (`get_tasks`/`get_events`) или
  идемпотентно генерируют файл (`export_tasks_xlsx` — просто лишний
  файл при дублировании), поэтому наблюдаемый эффект ограничен; до
  появления мутирующих write-tools (`create_task`/`send_email` и т.п.)
  это нужно закрыть atomic execution claim'ом (compare-and-set на
  `status`, не просто unique-constraint постфактум).
- **Message+FileArtifact linking не транзакционен** (P1, тот же аудит)
  — `createUserMessageIdempotent`/`sendMessage`/`streamMessage` создают
  `Message`+`FILE`-`MessagePart` и отдельным вызовом
  `linkAttachments`/`fileArtifact.updateMany` привязывают `FileArtifact`.
  Сбой процесса между этими двумя операциями оставляет `FILE`-часть,
  ссылающуюся на `FileArtifact` с `messageId: null` — `FilesCleanupCron`
  удалит такой файл как orphan через 24 часа, оставив в истории
  постоянно нерабочую ссылку. Нужно обернуть создание сообщения и
  линковку в один `prisma.$transaction`.
- **`LocalFileStorageService.delete()` глотает любую ошибку**, не только
  "файла уже нет" (P1, тот же аудит) — `FilesCleanupCron` удаляет строку
  `FileArtifact` из БД безусловно сразу после `storage.delete()`,
  независимо от того, удалился ли физический файл на самом деле.
  Настоящая ошибка диска (не ENOENT) навсегда осиротит файл — единственная
  запись, по которой его можно было бы найти и повторить попытку, уже
  удалена. Нужно пробрасывать все ошибки, кроме ENOENT, и не удалять
  строку в БД при неудачном `storage.delete()`.

## Telegram Mini App authentication

`apps/miniapp` — авторизация через `window.Telegram.WebApp.initData`,
проверяется HMAC-подписью с `TELEGRAM_BOT_TOKEN` на бэкенде
(`apps/api/src/telegram/telegram-init-data.ts`, по алгоритму из
документации Telegram). Привязка аккаунта — через одноразовое приглашение
(`TelegramInvite`, deep-link `t.me/<бот>/<mini-app>?startapp=<token>`), не
через отдельного бота. В обычном браузере (без `initData`) — dev-фолбэк на
email/пароль (`POST /auth/login`), тот же JWT на выходе в обоих случаях.

## TelegramBotService — важное ограничение текущей реализации

`apps/api/src/telegram/telegram-bot.service.ts` используется **только для
исходящих уведомлений** (push через `sendMessage`, прямой fetch на Bot API,
best-effort, никогда не бросает) — например, уведомление сотруднику о новой
задаче или новом участнике встречи. **Полноценного входящего Telegram
AI chat/voice pipeline (бот, который сам принимает голосовые сообщения или
текст от пользователя в чате с ботом и обрабатывает их) на данный момент
нет.** Весь голосовой пайплайн, описанный выше, работает только через
Mini App/Web App (запись голоса в браузере/WebView, HTTP на `/voice/parse`),
не через сообщения боту напрямую.

## Метрики и логирование voice-пайплайна (добавлено 15.09.2026)

Каждый вызов `POST /voice/parse` получает `requestId` (`crypto.randomUUID()`,
генерируется в начале `VoiceService.parse()`) — единственный correlation id
на весь запрос, присутствует в обеих лог-строках этого запроса и в
`entityId` соответствующей записи `AuditLog` (action `TRANSCRIBE`), так что
весь путь одного запроса грепается по одному id.

Строка `VoiceService`:
```
voice parse reqId=<uuid> audioBytes=<n> audioDurationMs=<n|n/a>
  sttMs=<n> contextDbMs=<n> llmFastMs=<n> llmStrongMs=<n>
  escalatedToStrongModel=<bool> executionMs=<n> totalMs=<n> draftsCount=<n>
```

Строка `DraftExtractionService` (логируется отдельно, до исполнения
действий):
```
draft-extraction reqId=<uuid> fastModel=<id> fastMs=<n> escalated=<bool>
  [strongModel=<id> strongMs=<n> reason=<LOW_CONFIDENCE|CLARIFICATION_NEEDED|BOTH>]
  confidence=<HIGH|MEDIUM|LOW>
```

`sttMs`/`contextDbMs` измеряются раздельно, но выполняются по-прежнему
конкурентно (каждый обёрнут в свой IIFE с собственным таймером внутри
общего `Promise.all` — распараллеливание не превращено в
последовательное выполнение ради замера).

**Что никогда не попадает в эти строки**: транскрипт, сырое аудио, ключи
API, JWT, токены Google/Plaud, содержимое сообщений. Логируются только
технические числа/флаги/enum-значения.

## Известные ограничения (не в рамках этого этапа)

- Контекст голосового агента ограничен последними ≤40 задачами/событиями и
  ≤20 репликами истории — компания с очень большим архивом активных задач
  получит усечённый контекст (сознательно отложено владельцем, см. пункт
  2.10 более раннего аудита).
- `TasksService.findAll`/`EventsService.findAll` внутри voice-пайплайна не
  пагинированы — тот же метод, что отдаёт полный список в UI.
- Крон-задачи (дайджест, синхронизация календаря/Plaud) не используют
  распределённую блокировку — на одном инстансе API это не проблема,
  станет проблемой при горизонтальном масштабировании.
