import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { google, calendar_v3 } from 'googleapis';
import { randomUUID } from 'crypto';
import { EventSource, EventStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { GoogleOAuthService } from './google-oauth.service';

// Google Calendar: end.date у all-day события ЭКСКЛЮЗИВЕН (однодневное
// событие 15 сентября требует end.date = "2026-09-16") — аудит 10.09.2026,
// п. 2.4: раньше отправляли/читали endAt как есть, без этой поправки,
// однодневное all-day событие уходило с нулевой длительностью и
// схлопывалось при обратном пуле. Внутри нашей БД endAt для all-day
// событий хранится ВКЛЮЧИТЕЛЬНО (последний день события, тем же смыслом,
// что startAt для однодневного) — эти два хелпера переводят между двумя
// представлениями на границе с Google API, больше нигде в приложении
// endAt all-day событий не участвует ни в каких расчётах.
function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// googleapis ошибки — обычный Error с добавленным .code (HTTP-статус), но
// без официального типа под это. `catch (err: any)` + err.code раньше
// проходило мимо @typescript-eslint/no-unsafe-member-access тихо — аудит
// 10.09.2026, п. 5.2, первый реальный прогон lint в CI, нашёл это.
function googleErrorCode(err: unknown): number | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'number') {
    return err.code;
  }
  return undefined;
}

// Раздел 14.2 ТЗ / Адъютант (28.08.2026): двусторонняя синхронизация.
// Единственный писатель с обеих сторон — руководитель, поэтому конфликт-
// резолюция упрощена до last-write-wins по времени последнего изменения,
// без полноценного merge (см. комментарий в schema.prisma у модели Event).
@Injectable()
export class GoogleCalendarSyncService {
  private readonly logger = new Logger(GoogleCalendarSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly oauth: GoogleOAuthService,
    private readonly config: ConfigService,
  ) {}

  private async calendarClient(employeeId: string): Promise<calendar_v3.Calendar> {
    const auth = await this.oauth.getAuthorizedClient(employeeId);
    return google.calendar({ version: 'v3', auth });
  }

  // Отправляет CONFIRMED-событие в Google — вставка или обновление в
  // зависимости от того, привязано ли оно уже к googleEventId. DRAFT
  // события не синхронизируются (раздел 10 ТЗ — черновик ждёт подтверждения
  // человеком, прежде чем становиться видимым во внешнем календаре).
  async pushEvent(employeeId: string, eventId: string): Promise<void> {
    const connection = await this.prisma.googleCalendarConnection.findUnique({ where: { employeeId } });
    if (!connection) return;

    const event = await this.prisma.event.findUniqueOrThrow({ where: { id: eventId } });
    if (event.status !== EventStatus.CONFIRMED) return;

    const calendar = await this.calendarClient(employeeId);
    const body: calendar_v3.Schema$Event = {
      summary: event.title,
      description: event.description ?? undefined,
      location: event.location ?? undefined,
      start: event.allDay
        ? { date: event.startAt.toISOString().slice(0, 10) }
        : { dateTime: event.startAt.toISOString() },
      // +1 день — наш endAt включительный, Google.end.date эксклюзивен
      // (см. комментарий у addDays выше).
      end: event.allDay
        ? { date: addDays(event.endAt.toISOString().slice(0, 10), 1) }
        : { dateTime: event.endAt.toISOString() },
    };

    // If-Match с текущим googleEtag на update (аудит 10.09.2026, п. 2.6):
    // без него правка, сделанная в самом Google секунду назад (до того как
    // её подхватит fallback-pull раз в 15 минут), молча затиралась бы
    // push'ем отсюда. На insert применять нечего — события ещё нет.
    const response = event.googleEventId
      ? await calendar.events.update(
          {
            calendarId: connection.calendarId,
            eventId: event.googleEventId,
            requestBody: body,
          },
          event.googleEtag ? { headers: { 'If-Match': event.googleEtag } } : undefined,
        )
      : await calendar.events.insert({ calendarId: connection.calendarId, requestBody: body });

    await this.prisma.event.update({
      where: { id: event.id },
      data: {
        googleEventId: response.data.id,
        googleEtag: response.data.etag ?? null,
        lastSyncedAt: new Date(),
        lastModifiedBy: EventSource.INTERNAL,
      },
    });
  }

  async deleteFromGoogle(employeeId: string, googleEventId: string): Promise<void> {
    const connection = await this.prisma.googleCalendarConnection.findUnique({ where: { employeeId } });
    if (!connection) return;

    const calendar = await this.calendarClient(employeeId);
    try {
      await calendar.events.delete({ calendarId: connection.calendarId, eventId: googleEventId });
    } catch (err) {
      // 410/404 — уже удалено на стороне Google, это не ошибка для нас.
      const code = googleErrorCode(err);
      if (code !== 410 && code !== 404) throw err;
    }
  }

  // Инкрементальная синхронизация: с syncToken запрашиваем только дельту,
  // без него — полный список вперёд от "сейчас" (первый sync или Google
  // сбросил токен, отдав 410 GONE).
  //
  // retriedAfter410 (аудит 10.09.2026, п. 2.5) — раньше на 410 функция
  // безусловно вызывала сама себя ещё раз; если бы Google отдал 410
  // повторно (бывает при проблемах на стороне календаря), это уходило в
  // бесконечную рекурсию до переполнения стека прямо внутри крона
  // (calendar-sync.cron.ts, fallbackPull). Теперь — не более одного
  // повторного захода: второй 410 подряд бросает исключение наверх
  // (там его и так ловит try/catch в кроне), а не рекурсирует снова.
  async pullChanges(employeeId: string, retriedAfter410 = false): Promise<void> {
    const connection = await this.prisma.googleCalendarConnection.findUnique({ where: { employeeId } });
    if (!connection) return;

    const calendar = await this.calendarClient(employeeId);
    let pageToken: string | undefined;
    let nextSyncToken: string | undefined;
    const items: calendar_v3.Schema$Event[] = [];

    try {
      do {
        const response = await calendar.events.list({
          calendarId: connection.calendarId,
          syncToken: connection.syncToken ?? undefined,
          pageToken,
          timeMin: connection.syncToken ? undefined : new Date().toISOString(),
          singleEvents: true,
          showDeleted: true,
        });
        items.push(...(response.data.items ?? []));
        pageToken = response.data.nextPageToken ?? undefined;
        nextSyncToken = response.data.nextSyncToken ?? nextSyncToken;
      } while (pageToken);
    } catch (err) {
      if (googleErrorCode(err) === 410 && !retriedAfter410) {
        // syncToken протух — полный ресинк с нуля, но только одна попытка.
        await this.prisma.googleCalendarConnection.update({
          where: { employeeId },
          data: { syncToken: null },
        });
        return this.pullChanges(employeeId, true);
      }
      throw err;
    }

    for (const googleEvent of items) {
      await this.applyGoogleEvent(connection.employeeId, googleEvent);
    }

    await this.prisma.googleCalendarConnection.update({
      where: { employeeId },
      data: { syncToken: nextSyncToken, lastSyncAt: new Date() },
    });
  }

  // Google Calendar API помечает автосгенерированные из Контактов события
  // (дни рождения) отдельным eventType, а не обычным "default" — надёжнее
  // фильтровать по этому полю, чем по названию (не зависит от языка
  // аккаунта). При желании сюда же можно добавить другие служебные типы
  // ('workingLocation', 'outOfOffice', 'focusTime'), если понадобится —
  // пока убираем только то, о чём попросил владелец.
  private static readonly IGNORED_EVENT_TYPES = new Set(['birthday']);

  private async applyGoogleEvent(employeeId: string, googleEvent: calendar_v3.Schema$Event): Promise<void> {
    if (!googleEvent.id) return;

    const existing = await this.prisma.event.findUnique({ where: { googleEventId: googleEvent.id } });

    if (googleEvent.eventType && GoogleCalendarSyncService.IGNORED_EVENT_TYPES.has(googleEvent.eventType)) {
      // Уже затянутое раньше (до этого фильтра) служебное событие — убрать
      // из нашей БД; в самом Google Calendar оно, разумеется, остаётся.
      if (existing) await this.prisma.event.delete({ where: { id: existing.id } });
      return;
    }

    if (googleEvent.status === 'cancelled') {
      if (existing) await this.prisma.event.delete({ where: { id: existing.id } });
      return;
    }

    const isAllDay = Boolean(googleEvent.start?.date && !googleEvent.start?.dateTime);
    const startAt = googleEvent.start?.dateTime ?? googleEvent.start?.date;
    // -1 день у all-day событий — Google.end.date эксклюзивен, наш endAt
    // включительный (см. комментарий у addDays выше).
    const endAt = googleEvent.end?.dateTime ?? (googleEvent.end?.date ? addDays(googleEvent.end.date, -1) : undefined);
    if (!startAt || !endAt) return;

    const googleUpdated = googleEvent.updated ? new Date(googleEvent.updated) : new Date();

    // Last-write-wins: если у нас есть неотправленная локальная правка
    // (менялась после последнего синка) новее, чем правка в Google —
    // не затираем её, следующий push отправит нашу версию.
    if (existing && existing.lastModifiedBy === EventSource.INTERNAL && existing.updatedAt > googleUpdated) {
      return;
    }

    const data = {
      title: googleEvent.summary ?? '(без названия)',
      description: googleEvent.description ?? null,
      location: googleEvent.location ?? null,
      startAt: new Date(startAt),
      endAt: new Date(endAt),
      allDay: isAllDay,
      status: EventStatus.CONFIRMED,
      googleEventId: googleEvent.id,
      googleEtag: googleEvent.etag ?? null,
      lastSyncedAt: new Date(),
      lastModifiedBy: EventSource.GOOGLE,
    };

    if (existing) {
      await this.prisma.event.update({ where: { id: existing.id }, data });
    } else {
      await this.prisma.event.create({ data: { ...data, createdById: employeeId } });
    }
  }

  // Push-уведомления Google Calendar API — канал живёт ограниченное время
  // (Google Calendar Push Notifications; максимум по документации — около
  // месяца, обычно короче) и требует продления кроном до истечения.
  async ensureWatchChannel(employeeId: string): Promise<void> {
    const connection = await this.prisma.googleCalendarConnection.findUnique({ where: { employeeId } });
    if (!connection) return;

    const webhookUrl = this.config.get<string>('GOOGLE_CALENDAR_WEBHOOK_URL');
    if (!webhookUrl) {
      this.logger.warn('GOOGLE_CALENDAR_WEBHOOK_URL не задан — push-уведомления недоступны, полагаемся на периодический pull');
      return;
    }

    const calendar = await this.calendarClient(employeeId);
    const channelId = randomUUID();

    const response = await calendar.events.watch({
      calendarId: connection.calendarId,
      requestBody: { id: channelId, type: 'web_hook', address: webhookUrl },
    });

    await this.prisma.googleCalendarConnection.update({
      where: { employeeId },
      data: {
        channelId,
        channelResourceId: response.data.resourceId ?? null,
        channelExpiresAt: response.data.expiration ? new Date(Number(response.data.expiration)) : null,
      },
    });
  }
}
