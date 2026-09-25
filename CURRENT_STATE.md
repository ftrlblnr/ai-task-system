# CURRENT_STATE — фактическое состояние системы (25.09.2026)

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

**Exactly-once execution (Phase F.3, P0, 20.09.2026)** — закрывает находку
внешнего аудита от того же дня. Идемпотентность (`conversationId`+
`clientRequestId`/`replyToMessageId` unique, P2002-recovery) защищала
только СТРОКИ в БД от дублей — два конкурентных запроса с одним
`clientRequestId`, оба прошедших `findExistingPair` до того, как первый
успевал записать assistant-строку, реально вызывали
`this.reply.reply()`/`streamReply()` (настоящий запрос к Anthropic +
инструменты) дважды. `AssistantChatService.claimOrJoin` — in-memory
`Map<userMessage.id, Promise<MessageWithParts>>`, не БД compare-and-set и
не распределённая блокировка (API работает одним процессом — тот же
принцип, что уже принят для cron-задач без distributed lock). Проверка
карты и запись в неё — синхронный код без `await` между ними, поэтому два
конкурентных вызова не могут интерливиться на этом участке в одном
процессе: какой бы из них ни выполнился первым, он успевает
"застолбить" ключ до того, как второй увидит карту. Второй присоединяется
к уже идущему выполнению вместо повторного вызова. Для `streamMessage`
"проигравший" получает `message.started`+`message.completed`/`failed` с
финальным результатом победителя, без live-дельт (реального стрима для
него не было). Если API когда-нибудь станет многопроцессным — этот
механизм перестанет координировать между процессами, потребуется
настоящая распределённая блокировка. Закреплено acceptance-тестом по
образцу из самого аудита: `Promise.all` с двумя одновременными вызовами
одного и того же логического запроса, `reply.reply()`/`streamReply()
called === 1` (тесты преднамеренно проверены на то, что падают при
временном откате фикса, не только на то, что проходят с ним).

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
- **`VoiceService.logAssistantMessage()`** (изначально `POST
  /voice/messages`, с Phase H.1 ниже — private-метод, вызываемый только
  изнутри `undo()`) пишет отдельное ("standalone", без
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
- **`apps/web`** (`app/voice/page.tsx`) архитектурно не тронут — там
  никогда не было текстового AI-чата, объединять нечего;
  `VoiceParseResponse` получил только аддитивные поля
  (`conversationId`/`userMessage`/`assistantMessage`), которые эта
  страница не читает (кроме `clientRequestId` в запросе, см. Phase H.1
  ниже). Клиентское поведение этой страницы всё же пришлось скорректировать
  в Phase H.1 — см. ниже про дублирующее логирование.
- **Живой прогон (20.09.2026, реальные Whisper+Claude)** нашёл и закрыл
  реальный баг: `clarificationReason` в схеме инструмента
  (`draft-extraction.service.ts`) — обычная строка, не nullable (Anthropic
  не поддерживает nullable-строки в строгой схеме), модель кладёт туда
  буквальный текст `"null"`, когда сказать нечего. Без гейта на
  `clarificationNeeded` (который был у прежнего фронтенда, но потерялся
  при переносе на бэкенд) каждый обычный голосовой ответ показывал бы
  лишний пузырь с текстом "null" — исправлено `resolveClarificationReason`,
  закреплено регрессионными тестами.

**Unified Voice Hardening (Phase H.1, 20.09.2026)** — второй внешний аудит
(того же дня) проверил уже реализованную Phase H и нашёл, что unified-
лента вскрыла новые риски, которых не было видно, пока голос и текст были
раздельны. Все три закрыты в этом же заходе:
- **`POST /voice/messages` удалён, заменён на `POST /voice/undo`** (P0/P1)
  — раньше этот эндпоинт принимал от авторизованного клиента ПРОИЗВОЛЬНЫЙ
  текст и записывал его в общую ленту с ролью `ASSISTANT` без какой-либо
  проверки содержимого — после Phase H это стало "conversation-history
  poisoning": лента теперь общий AI-контекст для голоса и текста разом,
  значит клиент мог подсунуть будущим ответам модели придуманную
  "предыдущую реплику ассистента". Новый `VoiceService.undo(dto, user)`
  сам выполняет откат (теми же `TasksService`/`EventsService`, что и
  `executeTaskAction`/`executeEventAction` — та же RBAC-проверка, не
  задвоена, плюс явная защитная проверка `Role.OWNER` для событий) и сам
  решает текст подтверждения — клиент присылает только структурированное
  описание (`VoiceUndoDto`: kind/action/id/previous/участники), не текст.
  `logAssistantMessage` стал `private` — его единственный вызывающий
  теперь `undo()`.
- **Дублирующее логирование в `apps/web/voice/page.tsx` убрано** (P0/P1) —
  после Phase H `VoiceService.parse()` сам сохраняет структурированный
  `assistantMessage` (chat-реплики, `clarificationReason`, итоги действий)
  в общую ленту; эта страница по инерции продолжала ЕЩЁ И сама вызывать
  `POST /voice/messages` с тем же текстом для каждого из них — чистый
  дубль в истории, который со временем засорял бы AI-контекст и тратил
  токены. Страница по-прежнему рендерит эти тексты локально (в свой
  localStorage-чат, она не читает историю с сервера), просто больше не
  логирует их отдельно — сервер уже сохранил.
- **Идемпотентность `/voice/parse`** (P0) — раньше не было вообще: сеть
  могла оборваться ПОСЛЕ того, как реальная мутация (создание/правка/
  удаление задачи или события) уже случилась, но ДО того, как ответ дошёл
  до клиента — повторная отправка того же аудио (например, автоматическим
  повтором на нестабильной сети) выполнила бы действие ещё раз. `dto`
  теперь принимает `clientRequestId` (тот же принцип, что у текстового
  `SendMessageDto`); `VoiceService.findCachedParseResponse` — короткое
  замыкание на уже сохранённую пару (user+assistant) по
  `(conversationId, clientRequestId)`, без повторного Whisper/Claude/
  исполнения действий (`results` на попадании в кэш — пустой массив: нет
  способа восстановить исходные `VoiceActionResult` из уже сохранённых
  `MessagePart` без потери полей вроде `taskId`/`previous`, нужных для
  undo — дубль всё же не создаёт лишней записи и не тратит Whisper/Claude
  второй раз, просто без кнопки "Отменить" на повторном показе). Найдена
  только user-строка без ответной (прошлая попытка умерла где-то
  посередине) — намеренно НЕ переиспользуется (её транскрипт мог быть от
  другой попытки распознавания, чем реально выполненные действия) — вместо
  этого удаляется, и запрос идёт как обычная новая попытка.
- **Сбой персистентности после уже выполненных действий не выглядит как
  сбой действия** (P1) — раньше `await userMessagePromise` без try/catch
  означал, что сбой сохранения истории (уже ПОСЛЕ того, как
  `executeTaskAction`/`executeEventAction` реально отработали) валил весь
  запрос 500-й ошибкой — пользователь видел "не удалось", хотя
  задача/событие уже создано/изменено/удалено. Теперь такой сбой явно и
  подробно логируется (какие действия уже выполнены), `results` (реальный
  исход) всё равно уходят клиенту как обычно, `userMessage`/
  `assistantMessage`/`conversationId` — `null` (аддитивное расширение
  типа, не breaking change) в этом редком случае — фронтенд просто не
  добавляет голосовую реплику в общую ленту, не теряя информацию о том,
  что действие реально произошло.

**Unified Voice Hardening (Phase H.2, 21.09.2026)** — третий внешний аудит
проверил уже реализованные Phase H/H.1 и нашёл риски, которые видны только
в объединённой ленте под конкуренцией/сбоями. Все закрыты в этом же заходе:
- **Exactly-once для `/voice/parse` под конкурентным повтором** (P0) —
  `findCachedParseResponse` (Phase H.1) ловит только ПОСЛЕДОВАТЕЛЬНЫЙ повтор
  после того, как прошлая попытка уже сохранилась в БД; конкурентный повтор
  (тот же `clientRequestId`, вторая попытка стартует ДО того, как первая
  успела дописать `Message`) раньше запускал Whisper/Claude/мутации задач-
  событий дважды. `VoiceService.inFlightParseRequests` — тот же приём и то
  же обоснование корректности (синхронный check-then-set без `await` между
  ними, единственный процесс API), что уже применён для текстового чата в
  `AssistantChatService.claimOrJoin` (Phase F.3) — второй конкурентный вызов
  присоединяется к уже стартовавшему промису вместо повторного запуска.
- **`conversationId` теперь передаётся явно** (P2) — `ParseVoiceDto` принял
  `conversationId?: string`; когда он есть, `VoiceService.parse` использует
  `assistantChat.assertOwnedConversation` (бросает, если не владелец) вместо
  прежней эвристики "последний разговор по `updatedAt`" — при нескольких
  открытых разговорах голос больше не может случайно попасть не в тот.
  `apps/miniapp`'s `assistant-screen.tsx` передаёт его, когда уже известен;
  `apps/web`'s `/voice` (нет понятия текущего разговора) не меняется —
  поле необязательное, работает по-старому через фолбэк.
- **`totalMs` занижал реальное время ответа** (P2) — метрика считалась ДО
  блока персистентности (`userMessage`/`assistantMessage`/линковка вложений),
  то есть не включала реальное время до отдачи HTTP-ответа клиенту. Перенесена
  после персистентности; добавлена отдельная `persistenceMs` в лог-строку.
- **Message+FileArtifact linking стал транзакционным** (P1) — раньше
  `createUserMessageIdempotent`/`sendMessage`/`streamMessage` создавали
  `Message`+`FILE`-`MessagePart` и ОТДЕЛЬНЫМ вызовом `linkAttachments`
  привязывали `FileArtifact`; сбой процесса между двумя операциями оставлял
  `FILE`-часть, ссылающуюся на осиротевший `FileArtifact` (`messageId: null`),
  который `FilesCleanupCron` тихо удалял через 24 часа, оставляя в истории
  постоянно нерабочую ссылку. Теперь `prisma.$transaction` оборачивает
  create/update сообщения и `fileArtifact.updateMany` атомарно — и для
  вложений пользователя (`createUserMessageIdempotent`), и для файлов,
  сгенерированных инструментами (`createAssistantMessageIdempotent`,
  `updateAssistantMessageWithAttachments` — используется и нестримингом, и
  успешным путём `streamMessage`). Проверено тестом со сбоем внутри
  `$transaction` (`fileArtifact.updateMany` бросает) — сообщение не остаётся
  наполовину сохранённым.
- **`LocalFileStorageService.delete()` больше не глотает реальные ошибки
  диска** (P1) — раньше любая ошибка (включая `EACCES`, диск недоступен и
  т.п.) молча проглатывалась, и `FilesCleanupCron` удалял строку
  `FileArtifact` из БД безусловно сразу после, независимо от того, удалился
  ли физический файл. Теперь пробрасывается всё, кроме `ENOENT` (файла и так
  уже нет — это ожидаемый успех, не ошибка); крон ловит проброшенную ошибку,
  логирует, НЕ удаляет строку (оставляет на повтор следующим часовым
  прогоном) и продолжает со следующим orphan'ом в той же партии — один
  сбойный файл больше не блокирует чистку остальных и не приводит к вечно
  осиротевшему файлу на диске.
- **`StorageRegistry`** (P2, заготовка на будущее S3/MinIO) — `FilesService`
  (`getDownloadStream`/`deleteUnattached`) и `FilesCleanupCron` теперь
  резолвят провайдер по `file.storageProvider` конкретного файла, а не
  всегда используют текущий инжектированный `FILE_STORAGE` (актуально только
  когда провайдеров станет больше одного — сегодня единственный `local`,
  но чтение/удаление уже готовы не зависеть от того, что является
  умолчанием ДЛЯ НОВЫХ файлов). Запись новых файлов (`FilesService.persist`)
  по-прежнему использует инжектированный `FILE_STORAGE` напрямую — так и
  должно быть, новый файл всегда идёт в текущее умолчание.
- **`FilesModule` DI: `useClass` → `useExisting`** (P3, попутная уборка) —
  `{ provide: FILE_STORAGE, useClass: LocalFileStorageService }` создавал
  ВТОРОЙ, независимый экземпляр `LocalFileStorageService` помимо уже
  зарегистрированного обычным provider'ом; сегодня безобидно (сервис не
  хранит per-request state), но нарушало принцип "один provider — один
  экземпляр". Заменено на `useExisting: LocalFileStorageService`.

**Durable voice exactly-once (Phase H.3, 21.09.2026)** — четвёртый внешний
аудит проверил Phase H.2 и указал, что `inFlightParseRequests` (P0 выше)
— это только БЫСТРЫЙ ПУТЬ для конкурентных запросов внутри ОДНОГО живого
процесса; после падения/рестарта процесса он ничего не знает о прошлой
попытке. Опасный сценарий, который аудит воспроизвёл в коде: business-
действие (`TasksService.create` и т.п.) уже выполнилось, но процесс упал
или сохранение истории переписки не удалось ДО того, как ответ дошёл до
клиента — повторный `/voice/parse` с тем же `clientRequestId` после
рестарта запускал бы весь пайплайн заново, включая уже случившуюся
мутацию (старый `findCachedParseResponse` из Phase H.1 при этом сценарии
удалял осиротевшую user-строку и позволял выполнить всё заново — именно
это аудит и указал как непойманный случай).
- **`VoiceExecution`** — новая таблица (`employeeId`, `conversationId`,
  `clientRequestId`, `status`, `resultJson`, `userMessageId`,
  `assistantMessageId`, `errorMessage`; `unique(conversationId,
  clientRequestId)`), durable claim жизненного цикла выполнения:
  `RECEIVED → PROCESSING → EXECUTING → COMPLETED`, либо `FAILED`
  (упало до начала действий — retry безопасен), либо
  `NEEDS_RECONCILIATION` (упало непредвиденно ПОСЛЕ начала действий —
  неизвестно, сколько из них выполнилось, retry небезопасен).
- **`VoiceService.claimAndRunDurable`** — `create()` строки на
  `(conversationId, clientRequestId)`; P2002 (строка уже есть) → смотрит
  на её статус: `COMPLETED` → `reconstructCompletedResponse` (реальный
  сохранённый `results`, не пустышка, как было в старом
  `findCachedParseResponse`); `FAILED` → безопасно начать заново на той
  же строке; любой другой статус (`RECEIVED`/`PROCESSING`/`EXECUTING`/
  `NEEDS_RECONCILIATION`) → явный отказ (`BadRequestException`) БЕЗ
  единого вызова `TasksService`/`EventsService` — тот же принцип "не
  трогать бизнес-логику при неуверенности", что и defensive RBAC-проверка
  в `undo()`.
- **Статус `COMPLETED` ставится СРАЗУ после исполнения действий**, до
  попытки сохранить историю переписки — именно факт "действия выполнены"
  (необратимый), а не факт "история сохранилась", решает, безопасен ли
  retry. Проверено тестом: retry на `COMPLETED` возвращает настоящий
  `resultJson` даже если персистентность в исходной попытке упала
  (Phase H.1 graceful degradation не пострадал).
- `inFlightParseRequests` (in-memory Map, Phase H.2) остаётся как
  оптимизация для конкурентных запросов внутри одного процесса — второй
  такой запрос просто ждёт тот же промис, не делая лишний round-trip к
  БД; реальная гарантия корректности теперь — `unique(conversationId,
  clientRequestId)` на уровне БД, переживающая рестарт процесса.

**Trusted server-side undo (Phase H.4, 21.09.2026)** — тот же четвёртый
аудит указал, что даже после Phase H.1 (сервер сам выполняет откат и сам
решает текст подтверждения) клиент оставался authoritative источником
ROLLBACK-ДАННЫХ: `POST /voice/undo` принимал `{kind, action, id, previous,
addedParticipantIds, removedParticipantIds}` от клиента — устаревший или
подделанный `previous` мог откатить задачу/событие в состояние, которого
никогда не было. Новая таблица `UndoRecord` (`employeeId`, `kind`,
`action`, `entityId`, `previous`, `addedParticipantIds`,
`removedParticipantIds`, `expiresAt`, `consumedAt`) — сервер сам создаёт
запись сразу после мутации (`executeTaskAction`/`executeEventAction`),
клиенту отдаётся только непрозрачный `undoToken` (id этой записи);
`POST /voice/undo` теперь принимает только `{undoToken}`. `expiresAt`
(30 секунд, то же окно, что раньше проверялось только таймером на
фронте) — теперь настоящая серверная граница, не только UX; атомарный
claim (`update` с `where: {id, status: AVAILABLE}`, ловит `P2025`) закрывает
гонку двойного одновременного вызова с одним токеном. **Статус-машина
`UndoRecordStatus` (`AVAILABLE → CLAIMED → COMPLETED`, или `CLAIMED →
AVAILABLE` при сбое самого отката — переработано в Phase L, см. ниже,
исходная версия Phase H.4 использовала только `consumedAt`.)** `VoiceActionResult`
(`VoiceTaskActionResult`/`VoiceEventActionResult`) — поле `previous`
заменено на `undoToken: string | null`, оба фронтенда (`apps/miniapp`,
`apps/web`) упрощены соответственно (собирать payload из `draft`/`previous`
больше не нужно). Живая проверка typecheck поймала реальный побочный
эффект: `apps/web`'s кнопка "Открыть" на только что созданную задачу
раньше читала `taskId` прямо из `undo.id` — заведено отдельное поле
`ChatMessage.openTaskId`, гаснущее вместе с `undo` по тому же таймеру
(то же поведение, что было раньше, просто из независимого поля).

**Employee Resolver + EmployeeAlias (Stage 2, Phase I, 21.09.2026)** —
раньше `assigneeId`, предложенный моделью, либо принимался как есть, либо
(при ошибке модели/несуществующем id) `validateReferences` тихо превращал
его в `null` — задача создавалась БЕЗ исполнителя, хотя пользователь явно
назвал имя ("Поставь Амиру задачу..."). Новая таблица `EmployeeAlias`
(`employeeId`, `alias`, `normalizedAlias`, `unique(employeeId,
normalizedAlias)`) — ручные короткие формы/никнеймы, управляются через
`POST/GET/DELETE /employees/:id/aliases` (OWNER-only). `EmployeeResolverService`
— независимая от LLM проверка: точное совпадение с alias → точное
совпадение с полным именем → эвристика общего ПРЕФИКСА слов (не список
курируемых падежных окончаний — тот ломается на словах вроде "Алексей"/
"Алексею", где окончание, срезаемое с одной формы, не совпадает с тем,
что срезается с другой, и на фамилиях на "-ов"/"-ев", где это не падежное
окончание, а часть основы; общий префикс с ограничением на длину "хвоста"
не подвержен этой асимметрии). `draft-extraction.service.ts`'s tool-схема
для `task_action` расширена полями `assigneeMentioned`/`assigneeRawText`
— модель обязана честно указать, был ли исполнитель вообще упомянут и
как именно (буквальный текст, не приведённый к именительному падежу),
даже если сама не смогла сопоставить его с id. `VoiceService.resolveAssigneeMention`
(новый шаг в pipeline черновиков, между `validateReferences` и
`attachAssigneeName`) при `assigneeMentioned=true` независимо резолвит
`assigneeRawText` через `EmployeeResolverService`: `RESOLVED` переопределяет
`assigneeId` результатом резолвера (доверяем ему больше, чем исходной
догадке модели); `AMBIGUOUS`/`NOT_FOUND` превращают черновик в уточняющий
вопрос вместо молчаливого создания задачи без исполнителя или с неверным.

**Company/STT vocabulary (Stage 2, Phase I, 21.09.2026)** — Whisper
регулярно ошибается на именах сотрудников и корпоративных терминах, не
встречавшихся в его обучающих данных. `CompanyVocabularyService` строит и
кэширует (TTL 10 минут — событийная инвалидация не нужна, отставание в
несколько минут не создаёт заметной проблемы) строку-подсказку из имён
ACTIVE-сотрудников + `EmployeeAlias.alias` + короткого хардкод-списка
терминов компании (GLB, Plaud, IDAT, Revit, BIM), передаётся как
`prompt` в `WhisperService.transcribe` (документированный OpenAI Whisper
API параметр для склонения распознавания к перечисленным словам). Капается
на ~400 символов (лимит Whisper — ~224 токена, кириллица кодируется в
токены менее эффективно латиницы).

**Plaud Sync v2 (Stage 2, Phase J, 21.09.2026)** — тот же аудит нашёл в
`plaud-sync.service.ts` два реальных бага:
- Запись без готового `auto_sum_note` на момент прогона крона молча
  пропускалась, но курсор (`lastSyncedCreatedAt`) всё равно продвигался
  мимо её `created_at` — на следующем прогоне запись уже НИКОГДА не
  рассматривалась заново, даже когда Plaud заканчивал обработку.
- Уже импортированная запись никогда не обновлялась при изменении
  содержимого на стороне Plaud — `if (existing) return;` тихо игнорировал
  любое изменение.

Новая таблица `PlaudSyncItem` (`employeeId`, `plaudRecordingId`,
`plaudCreatedAt`, `status` — `WAITING_FOR_CONTENT`/`SYNCED`/`FAILED`,
`contentHash`, `meetingId`) — отдельная память "видели, но не
синхронизировали", независимая от скалярного курсора: `WAITING_FOR_CONTENT`/
`FAILED` записи в пределах окна ретрая (7 дней) пересматриваются на
каждом прогоне вне зависимости от того, куда уже продвинулся курсор —
закрывает первый баг. `SYNCED` записи в том же окне тоже перепроверяются
по `contentHash` (Plaud API не отдаёт `updated_at` ни в списке файлов, ни
в деталях записи — сравнение хэша содержимого единственный доступный
способ заметить изменение) — при расхождении обновляется `title`.
**`Meeting.rawSummary` сознательно НЕ обновляется** даже при обнаруженном
изменении — её собственный комментарий в schema.prisma требует
неизменности (раздел 8.1 ТЗ: должна оставаться исходной версией для
сверки с обработанной) — это осознанный компромисс между рекомендацией
аудита ("обновлять при изменении") и уже существующим требованием
продукта, разрешённый в пользу последнего.

**MeetingSegment + transcript ingestion (Stage 2, Phase K, 21.09.2026)** —
новая таблица `MeetingSegment` (`meetingId`, `order`, `startMs`, `endMs`,
`speakerLabel`, `speakerEmployeeId?`, `text`) позволяет искать по
конкретным репликам с таймкодами, не только по общему саммари.
**⚠️ Реальный формат транскрипта, который отдаёт Plaud API, НЕ подтверждён
живым вызовом в этой сессии** (в отличие от `auto_sum_note`, который в своё
время был явно проверен чтением исходников `@plaud-ai/cli` — этот пакет
недоступен в текущем окружении, свериться было не с чем).
`PlaudApiService.findTranscriptNote` — best-effort перебор нескольких
предполагаемых `data_type` (`origin_text_note`/`transcript_note`/
`origin_note`) по аналогии с другими ASR-сервисами; `transcript-parser.ts`'s
`parseTranscriptSegments` — гибкий парсер предполагаемого JSON-формата
сегментов (несколько вариантов имён полей, эвристика секунды/мс). Оба
полностью протестированы независимо от вопроса "что именно возвращает
Plaud" — если реальный формат окажется другим, ошибка (или пустой список)
просто не даёт сегментов, не роняет синхронизацию summary, которая к
этому моменту уже успешно завершилась. **Перед тем как полагаться на эту
часть в проде — нужно подключить реальный Plaud-аккаунт с готовой записью
и свериться с фактическим `note_list` в ответе `GET /files/:id`.**

**Assistant meeting/Plaud tools (Stage 2, Phase K, 21.09.2026)** — до этой
фазы Assistant вообще не мог отвечать на вопросы про прошлые встречи
("что обсуждали на встрече по заводу", "что Жандос сказал про договор") —
только про задачи/календарь. Четыре новых OWNER-only инструмента (та же
видимость, что у всего `/meetings`, раздел 15 ТЗ):
`get_recent_meetings` (последние N, использует `MeetingsService.findAll`),
`search_meetings` (поиск по title/rawSummary/enhancedSummary, `contains`
без учёта регистра — не полнотекстовый поиск, простого `ILIKE` достаточно
для объёма встреч одной компании), `get_meeting` (делегирует
`MeetingsService.findOne` — тот же audit-log READ и 404, не задваивает),
`search_meeting_transcript` (поиск по `MeetingSegment.text`, опционально
ограничен одной встречей — best-effort, зависит от Phase K transcript
ingestion выше, честно возвращает пусто, если транскрипт ещё не
синхронизирован, промпт инструмента прямо просит не путать это с "ничего
не сказали по теме"). Ответы строятся по Postgres (Meeting/MeetingSegment),
не по runtime-запросу к Plaud API — тот же принцип "источник правды — БД",
что и у остальных инструментов. Намеренно нет отдельного типа карточки
под встречи (нет MEETING_CARD/UI под неё в этом заходе) — только
`TOOL_ACTIVITY`-статус + текстовый ответ модели.

**Пятый внешний аудит — 9 находок (Stage 2, Phase L, 21.09.2026)** —
пересмотрел код Phase H.4/I/J/K сразу после деплоя; все 9 находок
подтверждены чтением реального кода перед исправлением (не взяты на веру):

1. **`UndoRecord.create`/логирование — вторичные эффекты, не должны
   маскировать успешную мутацию.** `createUndoRecord` теперь ловит свою
   ошибку сама и возвращает `null` вместо проброса — `executeTaskAction`/
   `executeEventAction` (внешний `catch`, который иначе превратил бы уже
   случившееся создание/изменение задачи в `ok:false`) до этой правки
   ловил именно такую ошибку и терял факт успешной мутации для клиента.
   Аналогично `undo()`: `logAssistantMessage('Отменено.')` обёрнут в
   `.catch(() => {})` — сбой лога не превращает уже свершившийся откат в
   `ok:false` (находка №9).
2. **`ParseVoiceDto.clientRequestId` стал обязательным** (`@IsString()`
   без `@IsOptional()`) — раньше при отсутствии поля `VoiceService.parse`
   тихо шёл в обход всего durable exactly-once механизма (`claimAndRunDurable`/
   `VoiceExecution`, Phase H.3) прямиком в `runParse` без claim'а вообще.
   Оба фронтенда уже всегда отправляли его — изменение чисто серверное,
   закрывает теоретическую дыру для будущего/стороннего клиента.
3. **`PlaudSyncService` — транскрипт больше не зависит от `contentHash`
   summary.** Новое поле `PlaudSyncItem.transcriptSyncedAt` (независимое
   от `contentHash`): если summary/title не изменились (`contentHash`
   совпал — старое поведение сразу выходило по `return`), но транскрипт
   ещё не был готов к моменту первой успешной синхронизации summary,
   `syncItem` всё равно пробует досинхронизировать его на каждом
   прогоне, пока `transcriptSyncedAt` не проставлен. `syncTranscriptSegments`
   теперь возвращает `boolean` (реально записаны сегменты или нет) —
   именно это решает, ставить ли отметку.
4. **`transcript-parser.ts`'s секунды/мс эвристика ошибочно применялась и
   к однозначным полям.** `startMs`/`start_ms`/`endMs`/`end_ms` — имя поля
   уже говорит "это миллисекунды", но старый `pickMs` всё равно применял
   правило "< 100000 → домножить на 1000" ко всем полям без разбора:
   сегмент из первых ~1:40 записи (значение < 100000 мс) домножался на
   1000 ещё раз. Разделено на `pickExplicitMs` (без эвристики, для
   однозначных по имени полей) и `pickAmbiguousMs` (эвристика — только
   для `start`/`end`/`start_time`/`end_time`, где единица действительно не
   определена именем).
5. **`AssistantReplyService` — ограниченный многораундовый tool use**
   (`MAX_TOOL_ROUNDS = 3` вместо жёсткого 1). Раньше второй запрос
   инструмента от модели молча игнорировался — блокировало естественные
   многошаговые вопросы про Plaud-встречи (Phase K), например
   "найди встречу с Петром и процитируй, что он сказал про сроки"
   (`get_recent_meetings` → `search_meeting_transcript`, минимум два
   раунда). Не agentic loop в смысле §33 (та же модель/промпт/инструменты
   на каждом раунде, числовой потолок, никакого автономного планирования
   между произвольными агентами) — просто цикл вместо одной итерации.
6. **`EmployeeResolverService.wordsMatch` — допуск на "хвост"/разницу длин
   масштабируется по длине короткого слова**, а не фиксирован (`-2`/`≤3`)
   для всех длин. Фиксированный допуск был откалиброван на именах 6-7
   букв и давал реальные ложные совпадения на коротких: "Ким" (3 буквы) и
   "Кирилл" (6 букв) имеют общий префикс "ки" (2 буквы) — под старой
   формулой (`prefixLen ≥ minLen-2 = 1`) засчитывалось как совпадение.
   Теперь: 3-4 буквы — хвост 0 (короткое слово должно целиком быть
   префиксом), 5-6 — хвост ≤1, 7+ — прежний хвост ≤2 (поведение для
   длинных имён не изменилось).
7. **`MeetingSegment.speakerEmployeeId` наконец заполняется.** Поле
   существовало в схеме с Phase K, но ни один код путь его не трогал
   (подтверждено грепом — только объявление в `schema.prisma`).
   `MeetingsService.updateSpeakers` — там, где руководитель уже вводит
   сопоставление "Speaker N" → реальное имя для `enhancedSummary`
   (`speakerNames`) — теперь также резолвит каждое имя через
   `EmployeeResolverService` (среди ACTIVE-сотрудников) и, при `RESOLVED`,
   обновляет `MeetingSegment.speakerEmployeeId` для всех сегментов этой
   встречи с совпадающей `speakerLabel`. Best-effort: `AMBIGUOUS`/
   `NOT_FOUND` (например, внешний участник встречи) — сегменты просто
   остаются без `speakerEmployeeId`, не ошибка; сбой резолва не откатывает
   уже сохранённые `speakerNames`/`enhancedSummary`.
8. **`UndoRecordStatus` — полноценная статус-машина** (`AVAILABLE →
   CLAIMED → COMPLETED`, либо `CLAIMED → AVAILABLE` при сбое самого
   отката) вместо одного поля `consumedAt`. Раньше сбой отката (например,
   временная недоступность `TasksService.remove`) оставлял запись
   "наполовину потреблённой" — повторное нажатие "Отменить" в пределах
   `expiresAt` получало безопасный, но неверный "уже отменено", хотя
   реального отката не произошло. Теперь: неудачный откат в своём `catch`
   best-effort возвращает статус в `AVAILABLE`, позволяя пользователю
   повторить попытку.
9. См. пункт 1 — то же decoupling-решение применено и к `undo()`.

Все 9 находок закрыты в этом же заходе, каждая — с юнит-тестом на
конкретный регресс, проверенным по протоколу "временно откатить
исправление → тест падает → восстановить → тест снова зелёный"
(`voice.service.spec.ts`, `plaud-sync.service.spec.ts`,
`transcript-parser.spec.ts`, `assistant-reply.service.spec.ts` — новый
файл, `employee-resolver.service.spec.ts`, `meetings.service.spec.ts` —
новый файл).

**Шестой внешний аудит — Plaud transcript verified against a real live
payload (Stage 2, Phase M, 21.09.2026)** — пересмотрел Phase L сразу после
деплоя. Ключевое отличие от всех предыдущих раундов: на этот раз реальный
Plaud-аккаунт уже был подключён в проде, и вместо продолжения работы
вслепую была сделана прямая живая проверка — read-only Node-скрипт,
запущенный внутри `docker-api-1` (расшифровывает `PlaudConnection`'ный
access token через `SecretBoxService`'ный `ENCRYPTION_KEY` из окружения
контейнера, никогда не покидающий контейнер) вызвал реальный
`GET /files/:id` на боевой записи. Результат: **прежняя (Phase K) догадка о
формате транскрипта была неверна**, а заодно нашлась дополнительная,
конкретная ошибка в единицах времени:

- **Реальная структура**: транскрипт лежит в `detail.source_list`
  (`data_type: 'transaction'`, при непустом `'transaction_polish'` —
  причёсанная версия предпочитается), НЕ в `note_list` — прежние догадки
  (`origin_text_note`/`transcript_note`/`origin_note`) там просто не
  встречаются. `note_list` остаётся только для `auto_sum_note` (summary,
  уже подтверждён и работает) и как best-effort фолбэк на случай другого
  типа записи. `PlaudApiService.findTranscriptNote`/`PlaudFileDetail`
  переписаны под подтверждённую структуру, `plaud-api.service.spec.ts`
  теперь строит fixture по форме РЕАЛЬНОГО payload (содержимое реплик
  нейтрализовано, структура/имена полей — точная копия).
- **`start_time`/`end_time` у Plaud всегда уже в миллисекундах** —
  подтверждено конкретным значением (`start_time: 8790` для реплики на
  8.79 секунде записи). Старая эвристика "меньше 100000 → секунды"
  (находка №4 пятого аудита) применялась и к этим полям, домножая их на
  1000 ещё раз. `transcript-parser.ts`: `start_time`/`end_time` перенесены
  из `pickAmbiguousMs` в `pickExplicitMs` — эвристика секунд/мс остаётся
  только для голого `start`/`end` (без `_time`), для которых у Plaud
  реального подтверждения нет.
- **`PlaudSyncItem.transcriptHash`** (новое поле, независимое от
  `transcriptSyncedAt`) — раньше `transcriptSyncedAt`, однажды
  выставленный, навсегда блокировал повторную проверку транскрипта, даже
  если Plaud его потом дописал (запись была не до конца обработана на
  момент первого успешного sync). Теперь транскрипт хэшируется и
  сравнивается с прошлым значением на каждом прогоне (в пределах окна
  ретрая), независимо от того, изменилось ли summary.
- **`search_meeting_transcript`** теперь возвращает `speakerEmployeeId`/
  `speakerName` (резолвленное через `MeetingSegment.speakerEmployee`), не
  только сырую `speakerLabel` — Assistant может ответить "Жандос сказал",
  а не только "Speaker 2 сказал".
- **Resync транскрипта (delete+createMany) сохраняет ранее проставленный
  `speakerEmployeeId`** — раньше каждый ресинк (например, Plaud дописал
  запись) стирал уже сделанное руководителем сопоставление "Speaker N" →
  сотрудник; теперь сопоставление читается по `speakerLabel` до удаления и
  переносится на новые сегменты.
- **`MeetingsService.resolveSegmentSpeakers` очищает устаревший
  `speakerEmployeeId`** при AMBIGUOUS/NOT_FOUND, а не просто пропускает —
  если руководитель СНАЧАЛА привязал "Speaker 1" к сотруднику, а ПОТОМ
  исправил на нерезолвящееся имя, старое (уже неверное) сопоставление
  раньше оставалось на сегментах навсегда.
- **Частичный сбой участников события больше не проглатывается молча.**
  `VoiceService.executeEventAction`'s `addParticipant`/`removeParticipant`
  раньше ловили свою ошибку через `.catch(() => {})` без единого следа —
  событие создавалось (`ok: true`), но пользователь не узнавал, что часть
  названных участников не добавилась. Новое поле `VoiceEventActionResult.warning`
  (`string | null`) описывает, какие именно операции упали, `ok` остаётся
  `true` (сама мутация события успешна — тот же decoupling-принцип, что и
  у `createUndoRecord`/находки №1 пятого аудита), сбой также логируется.
  `undo()`'s аналогичные вызовы при откате участников теперь тоже
  логируются вместо полностью тихого игнорирования.

Все находки закрыты тем же заходом, с юнит-тестами на конкретный регресс,
проверенными по тому же протоколу "откатить → тест падает → восстановить →
тест снова зелёный".

**Седьмой внешний аудит — reliability/UX-фиксы (Stage 2, Phase N,
21.09.2026)** — пересмотрел Phase M сразу после деплоя. Из 8 утверждений
подтвердились 6 (проверено агентами-исследователями против реального кода);
два не подтвердились:
- "speaker mapping теряется, если задать `Meeting.speakerNames` до
  появления транскрипта" — на деле `updateSpeakers` резолвит сегменты
  сразу при каждом вызове, а вызвать его с реальными метками говорящих
  можно только когда сегменты уже существуют (метки берутся из показанного
  транскрипта) — сценария потери в реальности нет.
- "CURRENT_STATE.md противоречив" — Phase K/Phase M корректно оформлены
  как последовательная история, не как одновременные противоречия.

Закрыты 4 P0/P1 находки (P2-находки — audit logging для meeting search,
force-sync конкретной Plaud-записи — сознательно отложены владельцем):

1. **Event participant partial-failure warning не доходил до UI.**
   `VoiceEventActionResult.warning` (Phase M) строился backend'ом, но
   `buildVoiceAssistantParts` строил `EVENT_CARD` только из `entity`,
   `warning` нигде не читался; `EventCardData` не имела такого поля вовсе.
   Теперь `EventCardData.warning?` прокидывается в те же данные, что
   уходят в `MessagePart.data` (переживает перезагрузку истории без
   отдельной работы), Mini App показывает `⚠ {warning}` под карточкой
   (`.assistant-card-warning`), `apps/web`'s `/voice` (не использует
   карточки, только текст) дописывает предупреждение к тексту результата.
2. **Undo participant rollback мог быть частичным, но помечался
   COMPLETED.** Новый статус `UndoRecordStatus.PARTIAL` — если хотя бы одна
   операция отката участника (`addParticipant`/`removeParticipant`)
   падает, запись помечается `PARTIAL`, не `COMPLETED`; `VoiceUndoResponse`
   получает поле `warning`, `logAssistantMessage` пишет "Отменено
   частично. <детали>" вместо "Отменено." — Mini App подхватывает текст
   через обычную перезагрузку истории, `apps/web`'s `performUndo` (сам
   строит текст, не читает лог) обновлён явно.
3. **`VoiceExecution` зависал в `RECEIVED`/`PROCESSING` после краша
   процесса.** `claimAndRunDurable` раньше отказывал в retry для любого
   статуса, кроме `FAILED`, без учёта давности — если процесс падал ДО
   того, как успевал дойти даже до `FAILED` (например, во время STT),
   строка оставалась "якобы выполняется" навсегда. `STALE_VOICE_EXECUTION_MS`
   (3 минуты, используя уже существующее `VoiceExecution.updatedAt`) —
   `RECEIVED`/`PROCESSING` старше этого порога reclaim'ятся тем же путём,
   что и `FAILED` (business-мутация до этой точки ещё не начиналась,
   retry безопасен). `EXECUTING`/`NEEDS_RECONCILIATION` — поведение НЕ
   изменено (мутация могла уже случиться, автоматический retry небезопасен
   независимо от давности).
4. **Plaud summary freshness — новая версия с Plaud нигде не сохранялась.**
   `rawSummary` осознанно неизменна (раздел 8.1 ТЗ), но новое содержимое
   при обнаруженном изменении (`contentHash` не совпал) просто
   отбрасывалось после обновления `title`. Новое поле `Meeting.latestSummary`
   хранит то, что Plaud реально отдаёт сейчас; потребители саммари
   (`AssistantToolsService.getMeeting`/`searchMeetings`,
   `MeetingsService.extractTasks`) переведены на цепочку
   `enhancedSummary ?? latestSummary ?? rawSummary`.

Оставшиеся 2 P2-находки того же седьмого аудита закрыты отдельным заходом
(22.09.2026), без миграций схемы:

5. **Audit logging для `search_meetings`/`search_meeting_transcript`.**
   Оба инструмента Assistant'а раньше не оставляли следа в `AuditLog`
   вообще — в отличие от `MeetingsService.findOne`/`extractTasks` (раздел
   15 ТЗ), где обращение к конкретной встрече уже логировалось.
   `AssistantToolsService` получил `AuditService` (модуль `@Global()`,
   правка только конструктора). После успешного непустого поиска
   пишется `AI_MEETING_SEARCH`/`AI_TRANSCRIPT_SEARCH`: `entityId` —
   `meetingId`, если поиск по транскрипту сужен на конкретную встречу
   (есть реальная целевая запись), иначе сам поисковый запрос (поиск не
   привязан к одной записи, а по запросу видно, что искали). Пустой
   запрос (ранний return без обращения к БД) в `AuditLog` не пишется.
6. **Точечный force-resync одной записи Plaud.** `pullChanges`
   рассматривает запись, только если она попадает в курсор
   (`lastSyncedCreatedAt`) или в `RETRY_LOOKBACK_MS`-окно (7 дней) —
   запись старше этого окна, которую Plaud дообработал/изменил уже
   после него, никаким штатным прогоном крона больше не пересматривается
   вовсе. Новый `PlaudSyncService.forceSyncOne(employeeId, plaudRecordingId)`
   получает `detail` через `api.getFile` и делегирует существующему
   `syncItem` напрямую — та же идемпотентная `contentHash`-проверка, что
   и у обычного пути (реально не изменившееся содержимое не
   перезаписывается), просто в обход курсора/окна ретраев вокруг неё.
   Новый роут `POST /plaud/sync/:recordingId` (тот же `@Roles(OWNER)` на
   уровне контроллера, что и у остального модуля Plaud).

**Phase O — Meeting → Task workflow (22.09.2026)** — пользователь прислал
roadmap-документ на два больших этапа: "Phase L" (Meeting → Task) и
"Phase M" (Web Assistant parity, полный SSE-стриминг паритет Web с
Mini App). Названия "Phase L"/"Phase M" в самом документе конфликтовали с
уже занятыми внутренними именами этой кодовой базы (см. "Пятый внешний
аудит" и "Шестой внешний аудит" выше) — реализация помечена как Phase O
во избежание путаницы; Phase M из документа (Web Assistant parity)
сознательно отложена отдельным заходом (подтверждено пользователем) — это
отдельный многодневный проект (стриминг-протокол на Web, conversation
sidebar и т.д.), не входит в этот раунд.

Перед реализацией код проверен против спеки — значительная часть уже
существовала в другом виде:
- `Task.sourceMeetingId`/`sourceTimestamp`/`sourceContext` уже были в
  схеме (раздел 9 ТЗ, более ранний этап), уже отображались на Web
  (`tasks/[id]/page.tsx`) и в Mini App (`task-detail-overlay.tsx`).
- Отдельный REST-флоу "извлечь задачи из встречи" уже существовал
  (`MeetingsService.extractTasks`/`createTasksFromMeeting`, ручная
  модалка `task-extraction-modal.tsx`) — batch-предложение с explicit
  подтверждением, не разговорный сценарий.
- `apps/web` не имеет вообще никакого Assistant chat UI (только legacy
  `/voice`) — "TaskCard UI" для Assistant-чата в этом раунде коснулась
  только Mini App; Web получает отображение источника бесплатно через уже
  существующую страницу задачи.

Реализовано:
1. **`create_task_from_meeting`** — первый write-tool Assistant Core (все
   остальные тулы `assistant-tools.service.ts` — read-only). Видим только
   OWNER, тот же принцип, что у остальных meeting-тулов. Backend
   перепроверяет всё сам (LLM — не security boundary): `meetings.findOne`
   для доступа к встрече, `MeetingSegment.meetingId === meetingId` для
   сегмента (чужой/несуществующий segmentId — безопасный отказ, не
   exception), `EmployeeResolverService.resolve` для `assigneeRawText`
   (тот же резолвер, что уже используют voice/`updateSpeakers`) —
   `AMBIGUOUS`/`NOT_FOUND` не создаёт задачу вовсе, без fallback в
   `assigneeId: null`. Создание — только через `TasksService.create`, не
   прямой `prisma.task.create`.
2. **`Task.sourceSegmentId`** (новое поле, FK на `MeetingSegment`,
   `onDelete: SetNull`) — машиночитаемая ссылка на точный сегмент, если
   задача поставлена из конкретной реплики (`search_meeting_transcript`),
   не из summary целиком. `sourceTimestamp`/`sourceContext` (уже
   существовавшие поля) заполняются автоматически: `sourceTimestamp`
   форматируется сервером из `segment.startMs` ("MM:SS"/"H:MM:SS", новый
   `formatSegmentTimestamp`), не отдаётся на откуп модели.
3. **`TaskFromMeetingExecution`** (новая модель) — durable exactly-once
   idempotency для этого write-tool'а, тот же принцип, что
   `VoiceExecution`/`claimAndRunDurable` (create → P2002 → посмотреть
   status → `COMPLETED` возвращает кэш, `FAILED`/устаревший `CLAIMED`
   можно повторить, свежий `CLAIMED` — отказ). `dedupeKey` — хэш от
   `userMessageId` (стабилен при полном ретрае всего сообщения, в отличие
   от `tool_use.id` Anthropic, который при повторном вызове Claude каждый
   раз новый) + `meetingId`/`segmentId`/`title` — вторая, другая задача в
   том же ответе модели (другой title) не дедуплицируется ошибочно.
   Отдельная, маленькая, tool-specific модель, не общий
   "ToolExecution"-фреймворк — второго write-tool'а пока не существует.
4. **`conversationId`/`userMessageId` прокинуты через весь tool loop** —
   `AssistantReplyService.reply()`/`streamReply()`/`runReply()` теперь
   передают их в `AssistantToolsService.execute()` на каждом раунде (не
   только для write-tool'а) — нужны для idempotency-claim'а выше.
5. **`SYSTEM_PROMPT` получил date context** — раньше не содержал текущей
   даты/времени вообще (в отличие от voice); `buildDateContext()`
   переиспользует `nowInLocalTimezone()`/тот же паттерн, что уже был в
   `draft-extraction.service.ts` — не новый парсер дат.
6. **`TaskCardData.source`** (новое опциональное поле, тот же паттерн,
   что `EventCardData.warning`) — заполнено только для карточек из
   `create_task_from_meeting`. Mini App's `TaskCardView` показывает
   заголовок встречи + таймкод под карточкой (`.assistant-card-source`).
7. **Audit logging** — `AI_MEETING_TASK_CREATE` на успешное создание
   (`meetingId`/`segmentId`/`assigneeId`/`dueDate`, без транскрипта
   целиком).

Осознанно не реализовано в этом раунде (см. план): `extract_meeting_tasks`
как отдельный chat-tool (существующий REST-флоу уже закрывает batch-
сценарий), точная навигация "клик → подсветка сегмента" (пока только
заголовок+таймкод+цитата), `TaskSourceType`-enum (`sourceMeetingId != null`
уже однозначно отличает MEETING от MANUAL).

**Phase O hardening (22.09.2026)** — пользователь прислал отдельный
hardening-отчёт по только что задеплоенному Phase O, все 3 находки
подтвердились чтением реального кода:

1. **P0, crash-safe idempotency.** `taskFromMeetingExecution.update(
   ...COMPLETED...)` выполнялся ПОСЛЕ `tasks.create(...)` — если процесс
   падал между этими строками, execution оставался `CLAIMED`, после
   `STALE_TASK_FROM_MEETING_MS` (60с) становился reclaimable, и retry мог
   создать ВТОРУЮ Task для того же execution. Новое поле
   `Task.sourceExecutionId` (`@unique`, FK на `TaskFromMeetingExecution`,
   `onDelete: SetNull`) — физическая DB-гарантия "максимум одна Task на
   execution". Retry теперь СНАЧАЛА ищет Task по `sourceExecutionId` (сама
   таблица Task — надёжный источник истины, в отличие от
   `execution.status`, который мог не успеть записаться до крэша) и, если
   находит, возвращает её (самоисцеляя execution в `COMPLETED`), только
   при отсутствии Task идёт по прежней status-based reclaim-логике.
2. **P0/P1, dedupeKey зависел от LLM-текста.** Старый ключ — хэш от
   `userMessageId + meetingId + segmentId + title.toLowerCase()`. Два
   реальных сценария отчёта подтвердились: (а) две РАЗНЫЕ задачи с
   одинаковым `title`/`meeting`, но разным исполнителем (пример отчёта —
   "Амиру"/"Жандосу" с одинаковой формулировкой пункта) схлопывались бы в
   одну, поскольку `assigneeRawText` в ключ вообще не входил; (б)
   перефразирование `title` моделью между попытками ретрая меняло ключ —
   ретрай не распознавался. Новый ключ — чисто позиционная identity, не
   зависящая от LLM-generated текста: `` `${userMessageId}:${toolCallIndex}` ``,
   где `toolCallIndex` — общий счётчик на весь вызов `runReply()`
   (`AssistantReplyService`), не сбрасывается между раундами, инкрементируется
   на каждый обработанный `tool_use`-блок. Прокинут в
   `AssistantToolsService.execute()`'s 6-м параметром.
3. **P1, source integrity внутри `TasksService`.** Инварианты
   `sourceSegmentId` требует `sourceMeetingId`; `sourceSegmentId` должен
   принадлежать именно указанной встрече — раньше проверялись только в
   `create_task_from_meeting` (caller), не в самом `TasksService.create()`
   (domain service). Теперь проверяются и там (`BadRequestException`) —
   вторая, независимая линия защиты для ЛЮБОГО другого/будущего caller'а,
   не только для этого одного tool'а; RBAC-проверка (только OWNER) тоже
   расширена на весь набор source-полей, не только `sourceMeetingId`.

Все три фикса — чистый backend hardening без миграции UI-флоу
(`apps/web`/`apps/miniapp` не тронуты). После них Phase L (Meeting → Task)
считается закрытым; следующий этап — Phase M (Web Assistant parity),
отдельным заходом.

**Phase M — Web Assistant Parity (22.09.2026)** — перенос основного
AI-функционала Mini App на Web (раздел 36-58 присланного roadmap-
документа), без переписывания Assistant Core. Проверено против реального
кода перед реализацией: **backend уже полностью готов** —
`AssistantChatController`/`AssistantChatService` (`GET/POST
/assistant/conversations`, `.../messages`, `.../messages/stream`) ничем не
завязаны на Telegram/Mini App, JWT-аутентификация и владение
`Conversation` (по `employeeId`) уже общие для обеих платформ. Вся работа
этого раунда — только `apps/web`, порт уже проверенного в проде
клиентского паттерна из `apps/miniapp` (`assistant-screen.tsx`/
`assistant-message-part.tsx`), передизайненного под desktop.

Новое в `apps/web`:
1. **`src/lib/api.ts`** — добавлены `postStream`/`downloadBlob`
   (`postForm` уже был, см. `/voice`) — тот же 401/`localStorage`-паттерн,
   что и у существующих `request()`/`requestForm()`.
2. **`src/components/assistant-message-part.tsx`** (новый) — порт реестра
   `MessagePartRenderer` из Mini App один в один (markdown/task_card/
   event_card/tool_activity/error/file), с одним desktop-отличием:
   `TaskCardView`'s "Открыть" ведёт на уже существующую
   `/tasks/[id]`-страницу (`router.push`), не на модальный оверлей,
   которого на Web нет и заводить не нужно — там уже показывается
   `source`/`sourceTimestamp`/`sourceContext` (Phase O).
3. **`src/app/assistant/page.tsx`** (новый) — desktop 2-колоночная
   раскладка: слева список разговоров (`GET/POST /assistant/conversations`
   — Mini App всегда берёт `conversations[0]`, Web использует то же API
   богаче, раз оно уже поддерживает несколько `Conversation` на
   сотрудника), справа — почти дословный порт `send()`/SSE-парсинга/
   optimistic-сообщений/retry из `assistant-screen.tsx` (без Telegram-
   хаптики/`SwipeShell`). Вложения — тот же `POST /files/upload`/`DELETE
   /files/:id`. Голос — тот же `MediaRecorder`+`POST /voice/parse`
   (multipart) флоу, desktop-формулировки ошибок доступа к микрофону — те
   же, что уже в `apps/web/src/app/voice/page.tsx`.
4. **`src/components/sidebar.tsx`** — новый пункт "Ассистент" (`/assistant`,
   доступен всем, видимость tools уже решает backend).
5. **CSS** — новые классы (`.assistant-layout`/`.assistant-conversations-
   sidebar`/`.assistant-chat-pane` и т.д.), переиспользуют существующие
   design-токены (`--accent-soft`/`--radius-md`/`--shadow-sm`), не копируют
   mobile-специфичные классы Mini App буквально.

Осознанно вне рамок этого раунда: drag & drop файлов (обычный клик по
кнопке — как в Mini App, достаточно для MVP), редирект/депрекейт legacy
`/voice` (остаётся как есть, рабочая фича, отдельное решение), GPT-Live/
WebRTC (следующий этап дорожной карты).

Верификация: `apps/api` не тронут (0 изменений, 300/300 тестов уже
подтверждены в предыдущем раунде), `apps/web`/`apps/miniapp` по-прежнему
без frontend-тестовой инфраструктуры (см. "Известные ограничения" ниже) —
для новых файлов сделан точечный `eslint` (только изменённые файлы, с
уменьшенным `--max-old-space-size`, полный прогон на всём `apps/web`
гарантированно падает по OOM на этой VPS) — 0 errors. Живой смоук в
браузере — после деплоя.

**Phase M hardening — voice ↔ text meeting Q&A parity (22.09.2026)** —
живой смоук на только что задеплоенном `/assistant` (Web) сразу нашёл
разрыв: голосовой вопрос "О чём последняя запись из Plaud" получил
"я вижу только предстоящие события, встреч там нет" — тот же вопрос
ТЕКСТОМ уже отвечался корректно через `search_meetings`/
`get_recent_meetings`/`search_meeting_transcript`.

Причина, подтверждена чтением кода: голос и текст всегда шли по двум
РАЗНЫМ путям. Текст — `AssistantReplyService`'s tool loop
(`AssistantToolsService.buildTools`), с полным доступом к Meeting/Plaud
инструментам. Голос — `DraftExtractionService.extract()`, отдельный,
более ранний (Phase H и раньше) классификатор, чей контекст ограничен
ТОЛЬКО `tasks`/`events` (см. `TaskContextItem`/`EventContextItem`) —
Meeting-данные там были доступны только при диктовке СО страницы
конкретной встречи (`meetingId`), не для общих вопросов. Пользователь
выбрал (`AskUserQuestion`) наиболее полное решение: для `type:'chat'`-
черновиков (чистый вопрос-ответ, ничего не меняет) реальный текст ответа
теперь строит тот же tool loop, что и текстовый чат — `VoiceService`
вызывает `AssistantReplyService.reply(transcript, history, user,
conversationId, executionId)` вместо использования `draft.reply`
напрямую. `history`/`transcript` — те же данные, что уже собирал
`DraftExtractionService.extract()` (`loadContextAndExtract` теперь просто
возвращает уже вычисленный `history` тоже, вместо того чтобы держать его
только в своей области видимости). `executionId` (durable
`VoiceExecution.id`, не `userMessage.id`) — стабильная identity для
`create_task_from_meeting`'s idempotency-claim'а, специально НЕ зависящая
от best-effort персистентности голосовой реплики (Phase H.1): если
сохранение истории упадёт, чат-ответ всё равно должен успешно
построиться, ровно как раньше.

`task_action`/`event_action`-черновики (постановка/изменение/удаление
задач и событий голосом) НЕ затронуты — быстрый структурированный путь
через `DraftExtractionService` остаётся прежним, меняется только то,
откуда берётся текст ДЛЯ `type:'chat'`. `AssistantModule` теперь
экспортирует и `AssistantReplyService`, не только `AssistantChatService`
(`VoiceModule` уже импортировал `AssistantModule` с Phase H) — цикла
модулей нет (`AssistantModule` не импортирует `VoiceModule`).

**Competency-based assignee routing (Stage 2, Phase P, 22.09.2026)** —
следующий пункт присланного roadmap-документа ("Phase N" в его
собственной нумерации — внутренняя буквенная нумерация этой кодовой базы
уже дошла до Phase O по другому поводу, во избежание путаницы используется
следующая свободная буква): "Назначь эту задачу тому, кто отвечает за
юридические вопросы" — резолв роли/обязанности в конкретного сотрудника, не
только резолв по имени. Проверено перед реализацией: модель данных уже
полностью существовала (`Competency`/`EmployeeCompetency`, полный CRUD в
`competencies.service.ts`/`employees.service.ts`, судя по всему заведена
на более раннем этапе под админку сотрудников), но ни одна строчка кода
нигде не читала её для маршрутизации/подсказки исполнителя — этот раунд
закрывает ровно этот пробел, без миграции.

Новый read-only tool `find_employee_by_competency` (`AssistantToolsService`,
видим только `OWNER`, та же ветка `buildTools`, что и `create_task_from_meeting`
— они естественно работают в паре). `buildTools()` стал `async` (единственный
production-caller — `AssistantReplyService.runReply()`) — нужно, чтобы
вписать в схему тула закрытый `enum` реальных `competencyId` (тот же
принцип, что уже применён для `assigneeId` в `meeting-task-extraction.service.ts`:
модель не может сослаться на несуществующую запись), плюс человекочитаемый
список id/название/описание компетенций компании прямо в `description`
тула. Backend-логика ничего не решает сама: `prisma.employeeCompetency.findMany({
where: { competencyId, employee: { status: 'ACTIVE' } }, ... })` честно
отдаёт 0/1/много сотрудников с этой компетенцией — описание тула явно
инструктирует модель не угадывать при 0 (сказать пользователю, что никто
не отмечен) и не выбирать самой при 2+ (перечислить и спросить, кого
выбрать), продолжать сразу только при ровно 1 совпадении.

`create_task_from_meeting` не изменился вообще — ключевое архитектурное
решение раунда: `find_employee_by_competency` только НАХОДИТ реальное
полное имя сотрудника, дальше модель передаёт его как обычный
`assigneeRawText` в уже существующий, уже захардененный (Phase O)
`create_task_from_meeting`, который сам резолвит его через
`EmployeeResolverService`. Никакого нового доверия к модели не добавляется
— финальный `assigneeId` по-прежнему идёт только через уже проверенный
путь. Тот же tool доступен и голосовому `type:'chat'`-пути "бесплатно" —
он уже проходит через тот же `AssistantReplyService.reply()` (Phase M
hardening выше). Прямая ("не meeting-sourced") голосовая/текстовая
постановка задачи через `DraftExtractionService` компетенцией не
маршрутизируется — отдельный, structured-drafting путь, не проходящий
через tool loop вообще, вне рамок этого раунда.

Верификация: `cd apps/api && npx jest --silent` — 307/307 (было 301/301
до раунда), включая 6 новых/обновлённых тестов на RBAC-видимость тула
(закрытый enum, только `OWNER`, только если в компании настроены
компетенции) и на сам backend-запрос (0/1/много активных сотрудников,
неактивные исключены, отсутствующий `competencyId` — безопасная ошибка
без обращения к БД). Оба revert-check'а (RBAC-гейт на пустой список
компетенций, `ACTIVE`-фильтр в запросе) подтвердили падение ожидаемых
тестов при временном откате. Точечный `eslint` (только изменённые файлы)
— 0 ошибок.

**MUST-FIX #1 + #2 — roadmap v13 (23.09.2026)** — пользователь прислал
полный текст дорожной карты версии (13) целиком (документ ранее выпал из
контекста при более раннем сжатии разговора). Она явно указывает: после
Phase M/Phase N (Competency Routing, здесь — Stage 2, Phase P) следующий
шаг — не Phase O (GPT-Live/WebRTC), а два `MUST-FIX`, изначально
задуманные ДО Phase M/N ("BACKEND HARDENING STOP" сразу после них). Раз
Phase M/N уже сделаны без них — оба всё равно остаются нужны как реальные
корректностные баги, подтверждённые чтением кода перед фиксом:

1. **Plaud source filter.** `get_recent_meetings` принимал только
   `limit` — `MeetingsService.findAll()` отдавала вообще все `Meeting`,
   хотя `Meeting.plaudRecordingId` (`String? @unique`) уже существовал и
   уже выбирался. "О чём последняя запись из Plaud?" мог выбрать вручную
   заведённую встречу вместо реальной последней Plaud-записи. Новый
   параметр `findAll(source: 'all' | 'plaud' = 'all')` — `'plaud'`
   фильтрует `plaudRecordingId: { not: null }`; единственный другой
   caller (`MeetingsController` → `GET /meetings`) вызывает без
   аргумента, поведение не меняется. Схема тула `get_recent_meetings`
   получила `source: 'all' | 'plaud'` с явной инструкцией модели ("если
   пользователь говорит 'Plaud' — используй source='plaud'"), взятой
   почти дословно из формулировки самого roadmap-документа.
2. **Write-only idempotency index.** `AssistantReplyService.runReply()`
   растил один общий счётчик (`toolCallIndex`) на КАЖДЫЙ tool-вызов, а
   `create_task_from_meeting` (единственный write-tool) строил из него
   `dedupeKey = userMessageId:toolCallIndex` (hardening-раунд Phase O,
   22.09.2026). Баг: ретрай с ДРУГИМ числом read-tool вызовов
   (`search_meetings`/`get_meeting`/`search_meeting_transcript`) перед
   тем же write-вызовом получал другой индекс → другой dedupeKey → защита
   от дублей не срабатывала, хотя это логически тот же write-вызов.
   Новое: `AssistantToolsService.isWriteTool(name)`/`WRITE_TOOL_NAMES`
   (сейчас — только `create_task_from_meeting`, единственное место
   регистрации будущих write-tool'ов Phase P roadmap'а "Corporate Write
   Tools") — `runReply()` теперь ведёт отдельный `writeToolCallIndex`,
   увеличивающийся ТОЛЬКО на write-tool'ах; read-tool'ам в `execute()`
   передаётся `undefined` (параметр им и не нужен). Переименовано
   `toolCallIndex` → `writeToolCallIndex` во всей цепочке
   (`execute()`/`createTaskFromMeeting()`) для ясности терминологии.
   `Task.sourceExecutionId @unique` остаётся последней DB-гарантией
   независимо от этого фикса, не тронут.

Оба фикса — чистая application-логика, без миграции. Верификация:
`cd apps/api && npx jest --silent` — 312/312 (было 307/307 до раунда).
Оба revert-check'а подтвердили падение соответствующих тестов при
временном откате (source-фильтр — 3 новых теста в
`meetings.service.spec.ts`; write-only индекс — обновлённый тест
`assistant-reply.service.spec.ts`, ожидавший `[undefined, 0, 1]` вместо
старого `[0, 1, 2]` для `[search_meetings, create_task_from_meeting,
create_task_from_meeting]` — именно это изменение ожидания и фиксирует
закрытие бага). Точечный `eslint` — 0 ошибок. По roadmap-документу,
следующий шаг после этого раунда — Phase O (GPT-Live/WebRTC), отдельным
заходом.

**GPT-Live — живой голос по WebRTC (Stage 2, Phase Q, 24.09.2026; Web, с 24.09.2026 также Mini App)** —
"Phase O" roadmap'а v13 (внутренняя буква — следующая свободная). Цель roadmap'а:
`WebRTC → GPT-Live → Assistant Core → те же tools`, без нового слоя бизнес-
логики. GPT-Live делит роли: Live-модель (`gpt-live-1`) ведёт разговор
голосом и решает, когда делегировать; всё, что требует данных/действий,
делегируется бэкенду (`delegation.type = "client"`). Бэкенд — существующий
бэкенд: **делегированная задача исполняется тем же голосовым пайплайном, что и
push-to-talk, только без STT** (`VoiceService.parseTranscript` — транскрипт уже
готов): классификация задача/событие/вопрос, валидация, `EmployeeResolver`, RBAC,
исполнение `executeTaskAction/executeEventAction` (создание/изменение/удаление
задач и событий календаря), вопросы — tool loop Assistant Core; durable
exactly-once (`VoiceExecution`, `clientRequestId="live:<delegationId>"`),
запись реплики и ответа с карточками в общую ленту (видна в текстовом чате и
Mini App). (Первая версия шла через `AssistantChatService.sendMessage` — текстовый
Assistant Core без tools создания задач/событий: живой режим отвечал «не могу
создать»; исправлено 24.09.2026.) Responses-
делегация OpenAI (второй набор tools на другой модели) сознательно не
используется — это и был бы новый слой логики.

`apps/api/src/live/` (`LiveService`/`LiveController`, флаг `LIVE_VOICE_ENABLED`):
- `POST /live/sessions {sdp, conversationId?}` — сервер сам обменивает SDP с
  OpenAI (`POST /v1/live/sessions`), ключ браузеру не отдаётся. Проверка
  владения разговором — ДО обращения к OpenAI. Права data channel браузера
  урезаны (`allowed_client_events: ['session.close']`, серверные события —
  только транскрипты/делегации/started/closed): браузер untrusted. Одна живая
  сессия на сотрудника (биллинг посекундный — предыдущая закрывается),
  потолок `LIVE_MAX_SESSION_MS` (10 мин). `DELETE /live/sessions/:id`,
  `GET /live/status`.
- Sideband-WebSocket (`wss://api.openai.com/v1/live/sessions/{id}/attach`,
  зависимость `ws`): копит `session.input_transcript.delta`; на
  `session.delegation.created` (событие НЕ содержит текста запроса) собирает
  запрос из ring buffer транскрипта (см. «Hardening» ниже), ставит в очередь
  сессии (делегации строго по порядку),
  дедуп по `delegation.id`, `VoiceService.parseTranscript(..., "live:<id>")`,
  итог озвучивает `toSpokenLiveReply` (`live/live-spoken-reply.ts`) из выполненных
  `results[]`: «Создал задачу «X», исполнитель …, срок …», «Добавил в календарь «Y»
  на … в …», ответы на вопросы; очищено от markdown, ≤900 символов с пометкой
  «подробности в чате» → `session.commentary.append`. `ok=false`/исключение —
  безопасная фраза без `err.message`, никогда «успех». Логи: только исходы/тайминги/usage, без
  транскриптов.
- Write-действия в живом голосе — автоматически, как в тексте (решение
  пользователя; roadmap: low-risk create → automatic); ассистент проговаривает,
  что создал.

`apps/web`: `src/lib/live-voice.ts` (`LiveVoiceClient`: getUserMedia →
RTCPeerConnection → data channel `oai-events` → SDP через наш API), кнопка
«Живой голос» и панель с субтитрами на `/assistant`; пока сессия живая, лента
подтягивается раз в 2 с (браузер не получает сигнала «делегация завершена» —
sideband серверный). Push-to-talk `/voice/parse` не тронут.

**Mini App (24.09.2026)** — тот же backend без изменений (`/live/status`,
`/live/sessions`); клиент `apps/miniapp/src/lib/live-voice.ts` — порт
web-версии (дублирование между приложениями — как у остальных клиентских
модулей) с поправками под мобильный WebView: `playsinline` и явный
`audio.play()` с понятной ошибкой (autoplay в WebView удаётся не всегда).
`assistant-screen.tsx`: кнопка с наушниками рядом с микрофоном (по
`GET /live/status`), панель «Идёт разговор» с субтитрами и «Завершить» над
composer'ом, haptic на старт/стоп/ошибку, тихая подтяжка ленты раз в 2 с, пока
сессия живая. Разговор — единственный тред Mini App (`conversations[0]`), то
есть та же лента, что в Web. **Не проверено:** реальное поведение микрофона/
WebRTC/звука в Telegram WebView на iOS и Android — только сборка (tsc, eslint);
нужен ручной прогон на телефоне.

**GPT-Live hardening — закрытие Phase O (24.09.2026)** — внешний анализ назвал
три must-fix; все проверены по докам OpenAI и коду, затем исправлены:
1. **Транскрипт/контекст.** Доки: `session.input_transcript.delta` — фрагменты,
   без границ ходов и без события done; связь `offset_ms` делегации с
   `start_ms` фрагментов не описана. Вместо строки `pendingInput` + фиксированных
   400 мс — `LiveTranscriptBuffer` (`live/live-transcript-buffer.ts`): фрагменты
   обеих сторон (`input_`/`output_transcript.delta`) с таймингами, окно ≈3 мин /
   ≤200 фрагментов / ≤6000 символов. `takeTurn(offset_ms)` атомарно отдаёт
   текущую команду (непотреблённые user-фрагменты с `start_ms ≤ offset_ms`) и
   контекст БЕЗ неё (последние ≤8 ходов / ≤1500 символов, включая прошлые
   реплики Live-ассистента). Ожидание хвоста — адаптивное, не фиксированное:
   `coverage` (покрытие user-речи дошло до `offset_ms`) или `quiet` (250 мс без
   новых user-дельт), потолок 2000 мс (`cap`); исход логируется — это эвристика.
   Контекст уходит **только моделям**: `parseTranscript(..., {liveContext})` →
   блок `[live_context]…[/live_context]` перед командой и в извлечении
   черновиков (`DraftExtractionService`), и в chat-ответе (как `[attached_file]`);
   в ленту сохраняется чистая команда. В
   `SYSTEM_PROMPT` описан блок, `stripLeakedContextMarkers` вырезает его утечку.
2. **`session.input`.** Поле принимается при создании сессии (≤128 сообщений и
   ≤8192 токенов, роли user/assistant, только текст). `AssistantChatService.
   getRecentMessages` берёт последние ~20 `COMPLETED` сообщений и только
   MARKDOWN-части (карточки, статусы инструментов, файлы не попадают);
   `buildSessionInput` — ≤800 симв./сообщение, ≤6000 суммарно (запас к лимиту
   токенов: поведение при превышении в доках не описано). Пустой разговор — поле
   не передаётся; сбой чтения истории не блокирует живой голос.
3. **Жизненный цикл.** (а) `createSession` возвращает SDP только после `open`
   sideband (таймаут 4 с; при неудаче — закрыть сокет, `POST /v1/live/sessions/
   {id}/hangup`, контролируемая ошибка); регистрация в картах — после `open`,
   параллельный create того же сотрудника закрывает предыдущий. `hangup` — также
   fallback закрытия при мёртвом sideband. (б) `LiveVoiceClient`: счётчик
   поколений — `stop()` во время `connecting` инвалидирует незавершённый
   `start()`; поздний ответ `POST /live/sessions` закрывает свою серверную
   сессию (`DELETE`), не трогая закрытый pc; микрофон освобождается, если Stop
   нажат до выдачи разрешения. (в) Найдено сверх анализа: клиент теперь ждёт
   `iceGatheringState === 'complete'` (10 с) перед отправкой SDP-offer — сервер не
   поддерживает trickle-ICE, offer без кандидатов не соединится (как в
   официальном примере OpenAI).

Осознанно вне рамок (по решению пользователя): Redis/распределённые сессии,
event sourcing, персистентность полного транскрипта, идеальные прерывания,
Telegram Live. Верификация: `cd apps/api && npx jest --silent` — 365/365 (было
332/332); revert-check'и подтверждены (адаптивное ожидание, `consumed`, исключение
текущей команды из контекста, ожидание sideband, MARKDOWN-фильтр истории).
Пробел: в `apps/web` нет тест-раннера, поэтому «Stop во время POST» и «поздний
ответ» автотестом не покрыты — проверяются ручным прогоном (Start → мгновенный
Stop → повторный Start; в логах api нет висящих сессий).

**Регресс «Live не создаёт задачи/события» (24.09.2026):** первый живой прогон
пользователя («поставь задачу Азамату… и запись в календаре») получил «нет
инструмента создания задач без встречи / нет доступа к событиям» — делегации шли в
текстовый Assistant Core (у него только `create_task_from_meeting` и нет
календарных write-tools). Теперь `VoiceService` принимает вход `audio | text`
(`VoiceInput`), `LiveService` зовёт `parseTranscript`. Undo-кнопок для
live-действий нет (токены приходят только в ответе `/voice/parse`). Создание
задач/событий в **текстовом** чате Assistant по-прежнему недоступно — roadmap
«Phase P — Corporate Write Tools». Whisper на неразборчивой записи вернул словарь-подсказку — это
НЕ мелочь, разобрано ниже («Инцидент push-to-talk»).
Верификация: jest 380/380 (exit 0); локальные api `tsc`/`eslint` на VPS не
завершаются — вердикт CI.

**Инцидент push-to-talk (24.09.2026) — эхо подсказки Whisper + подмена уточнений.**
Пользователь надиктовал «поставь задачу Азамату… и запись в календаре». Результат:
(1) первая попытка — Whisper вернул **саму подсказку-словарь** «Мухамедкаримов
Азамат, GLB, Plaud, IDAT, Revit, BIM» как транскрипт (известный эффект `prompt` на
неразборчивой/тихой записи); он принимался как команда, писался в общую ленту и
отравлял контекст следующей команды; (2) вторая попытка распозналась верно, но
задача не создалась, а событие создалось — потому что мой перехват Phase M
(22.09.2026, «голос отвечает как текстовый чат») подменял **любой** chat-черновик
ответом Assistant Core, в том числе собственные уточнения пайплайна («не нашёл
сотрудника…», «на какое время?», объяснение для не-руководителя): Assistant Core
отвечал «не могу создавать задачи/события» (он и правда их не умеет). Пробный
разбор той же фразы на реальной модели дал верные `task_action`+`event_action`,
так что причина — не классификатор. Исправлено:
- `stt-echo.ts` (`isPromptEcho`): транскрипт, совпадающий с подсказкой (полностью,
  обрезанно или ≥90% слов из неё; 1–2 слова — обычный ответ, не эхо) → повтор
  распознавания **без** подсказки (эхо без неё невозможно); пустой транскрипт →
  явная ошибка «Не удалось разобрать речь — повторите», в ленту ничего не пишется.
  В лог-строку добавлено `sttRetriedWithoutPrompt`.
- Уточнения самого пайплайна помечены (`serverNotice`, поле `origin:'server'`) и
  больше не подменяются. Assistant Core отвечает **только на чистый информационный
  вопрос**: все черновики — обычный chat модели, `clarificationNeeded=false`.
  Смешанная реплика (действие + chat) и просьба модели уточнить сохраняют текст
  черновика. Паритет голос↔текст для Plaud-вопросов сохранён.
Эффект распространяется и на Live (тот же пайплайн). Тесты: jest 392/392 (exit 0);
revert-check'и эха, подмены и пустого транскрипта подтверждены.

**Mail.ru Email Intelligence — выкат 1 «фундамент» (Stage 2, Phase R, 25.09.2026;
«Phase P» roadmap'а).** Почта Mail.ru синхронизируется в локальную PostgreSQL по
IMAP; ассистент/веб работают по БД, а не ходят в Mail.ru на каждый запрос.
Решения владельца: подключать ящик может только **OWNER**; экран — **только Web**;
утренняя сводка (08:30 Алматы, сохранение + Telegram) — **выкат 2**. Объём выката
1 (P1 без AI): подключение, Inbox+Sent, треды, read/unread, replied/unanswered.
`apps/api/src/mail/`:
- **Абстракция провайдера** (`providers/email-provider.ts`, `EmailProvider`/
  `EmailSession`, типизированные ошибки `MailConnectError` с безопасными кодами
  `INVALID_CREDENTIALS|IMAP_DISABLED|TIMEOUT|UNKNOWN`), реализация
  `MailRuImapProvider` (`imap.mail.ru:993` TLS, `imapflow`, `logger:false` — пароль
  не попадает в лог; письма разбираются `mailparser`, тела режутся, вложения не
  скачиваются — только метаданные; письмо >5 МБ читается частично).
  `MailProviderRegistry` — единственное место соответствия «провайдер → реализация».
- **Подключение** (`MailConnectionService`): реальный вход по IMAP до сохранения;
  пароль **приложения** (не обычный) хранится только зашифрованным (`SecretBox`
  AES-256-GCM), наружу/в лог/промпт не попадает; понятные ошибки («нужен пароль
  для внешнего приложения», «IMAP выключен», таймаут). Начальная синхронизация — в
  фоне, окно 30/90/180 дней.
- **Синхронизация** (`MailSyncService` поверх тонкого `MailStore`): Inbox + Sent
  (Sent обязателен для «ответил ли я»), идемпотентно (`unique(folderId, uid)` +
  сопоставление по Message-ID при смене UIDVALIDITY), курсор `lastUid` после каждого
  батча, батчи по 50, потолок 300 писем за прогон (большой ящик догоняется за
  несколько прогонов; контейнер api — 512 МБ), обновление `isRead` по флагам,
  пропавшие с сервера — `providerMissing` (не удаляются; пустой ответ по флагам не
  считается «всё удалено»), один синк на ящик, cron каждые 10 минут, пауза после 3
  подряд ошибок авторизации (не долбим Mail.ru неверным паролем).
- **Треды** (`thread-resolver.ts`, чистый): Message-ID/In-Reply-To/References
  (включая «ребёнок раньше родителя» и слияние тредов); **только без заголовков
  связи** — фолбэк тема+участники+14 дней (тема — не единственный ключ).
  **Reply-status** (`reply-status.ts`): AWAITING_MY_REPLY/REPLIED/NO_REPLY_REQUIRED/
  AWAITING_THEIR_REPLY/UNKNOWN по последнему письму треда; без AI-анализа входящее —
  UNKNOWN (рассылки по заголовкам — NO_REPLY_REQUIRED).
- **Запросы** (`MailQueryService`, `buildEmailWhere`): те же фильтры, что нужны
  ассистенту (даты, отправитель, получатель, тема, текст `ILIKE`, read/unread,
  replyStatus, importance, вложения); каждый запрос ограничен `mailboxId` владельца.
- `MailController` (OWNER): `GET /mail/status`, `POST /mail/connect`,
  `DELETE /mail/disconnect`, `POST /mail/sync`, `GET /mail/messages[/:id]`.
- БД: миграция `20260925090000_add_email_intelligence` (только новые таблицы:
  Mailbox, EmailFolder, EmailThread, EmailMessage, EmailRecipient, EmailAttachment,
  EmailAnalysis, EmailDigest — последние две заполняются в выкате 2).
`apps/web`: страница «Почта» (`/mail`, пункт в sidebar для OWNER): форма
подключения с инструкцией, статус синка/ошибки, «Синхронизировать»/«Отключить»,
список с фильтрами (все/непрочитанные/ждут ответа/важные) и поиском, деталь письма
с тредом. **Не проверено на реальном ящике** (специфика Mail.ru: имена папок/
special-use, точный текст ошибки «IMAP выключен», лимиты частоты логинов) — поэтому
выкат 1 отдельный, дальше AI-анализ, tools и сводка. Тесты: jest 460/460
(+68 в `mail/`); revert-check'и (Sent=исходящие, сопоставление по Message-ID,
пауза после ошибок, защита от массового «пропало», треды по заголовкам) подтверждены;
локальные api `tsc`/`eslint` на VPS не завершаются — вердикт CI.

**Не подтверждено доками (проверяется живым прогоном):** доставка
`session.delegation.created` на sideband для WebRTC-сессии (страницы доков
противоречат друг другу), точные имена client-событий (`session.commentary.
append`), качество русского у `gpt-live-1`. Поэтому фича за флагом, неизвестные
типы sideband-событий логируются по имени. Карта сессий — in-memory (один
процесс API, как остальные координаторы): рестарт API рвёт живые сессии.
Верификация: `cd apps/api && npx jest --silent` — 332/332 (было 312/312),
20 тестов `live.service.spec.ts`; revert-check'и (дедуп делегаций, обрезка,
одна сессия на сотрудника, проверка владения) подтверждены; `apps/web`:
`tsc --noEmit` без ошибок в новых файлах, scoped `eslint` — 0 ошибок.
Локальные `tsc`/`eslint` для `apps/api` на этой VPS упираются в своп и не
завершаются — их вердикт даёт CI (`gate`): первый прогон нашёл 6 lint-ошибок
(`require-await` в моках, неявный `toString()` у `ws.RawData`), исправлены.

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
