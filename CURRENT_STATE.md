# CURRENT_STATE — фактическое состояние системы (15.09.2026)

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
- `VoiceMessage` — история голосового диалога (память чата, см. ниже).
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
     `OWNER`), активные сотрудники, память диалога (последние ≤20 реплик
     этого пользователя за последние ≤3 часа, `VoiceMessage`), и — если
     диктовка со страницы встречи — саммари этой встречи.
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
8. Реплика пользователя пишется в `VoiceMessage` сервером сама (fire-and-
   forget); финальный текст ответа ассистента дописывает фронтенд отдельным
   `POST /voice/messages`, когда текст в чат-пузыре становится окончательным
   (сервер не дублирует логику форматирования, которая уже есть на
   фронтенде).

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
