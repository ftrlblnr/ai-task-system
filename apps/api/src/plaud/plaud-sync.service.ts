import { createHash } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { PlaudSyncStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PlaudApiService, PlaudFileDetail, PlaudFileListItem } from './plaud-api.service';
import { parseTranscriptSegments } from './transcript-parser';

const PAGE_SIZE = 20;

// Stage 2, Phase J (внешний аудит 21.09.2026, "Plaud Sync v2") — сколько
// назад пересматривать WAITING_FOR_CONTENT/FAILED записи и перепроверять
// SYNCED записи на изменение содержимого. Не бесконечно — иначе каждый
// прогон крона со временем бил бы по всей истории; 7 дней с запасом
// покрывает и "Plaud ещё обрабатывает запись" (обычно минуты-часы), и
// "руководитель поправил саммари вскоре после записи".
const RETRY_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

// Убираем декоративный постер записи (presigned-ссылка на картинку, живёт
// считанные минуты — незачем тащить битую ссылку в сохранённый markdown).
function stripImages(markdown: string): string {
  return markdown.replace(/!\[[^\]]*]\([^)]*\)\n?/g, '').trim();
}

function contentHashOf(title: string, rawSummary: string): string {
  return createHash('sha256').update(`${title}\n${rawSummary}`).digest('hex');
}

// Синхронизация встреч из Plaud (владелец 08.09.2026) — переносит только
// саммари (auto_sum_note), транскрипт сознательно не храним (см. план).
//
// Stage 2, Phase J (внешний аудит 21.09.2026) закрыл два найденных бага:
// 1. Запись без готового summary на момент прогона раньше терялась
//    НАВСЕГДА — importFile молча возвращался, но курсор (lastSyncedCreatedAt)
//    всё равно продвигался мимо её created_at, и следующий прогон уже не
//    рассматривал её снова, даже когда Plaud заканчивал обработку. Теперь
//    PlaudSyncItem — отдельная память "видели, но не синхронизировали",
//    независимая от курсора (см. её комментарий в schema.prisma).
// 2. Уже импортированная запись никогда не обновлялась, если Plaud менял
//    её содержимое — `if (existing) return;` тихо игнорировал любое
//    изменение. Теперь недавно синхронизированные записи перепроверяются
//    по contentHash (Plaud API не отдаёт updated_at, сравнение по хэшу —
//    единственный способ заметить изменение). НЕ трогаем Meeting.rawSummary
//    при обнаруженном изменении — её собственный комментарий в
//    schema.prisma прямо требует неизменности (раздел 8.1 ТЗ, чтобы всегда
//    можно было сверить с обработанной версией); обновляется только title.
@Injectable()
export class PlaudSyncService {
  private readonly logger = new Logger(PlaudSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly api: PlaudApiService,
  ) {}

  async pullChanges(employeeId: string): Promise<void> {
    const connection = await this.prisma.plaudConnection.findUnique({ where: { employeeId } });
    if (!connection) return;

    const newFiles: PlaudFileListItem[] = [];
    let page = 1;
    outer: for (;;) {
      const response = await this.api.listFiles(employeeId, page, PAGE_SIZE);
      const items = response.data ?? [];
      if (items.length === 0) break;

      for (const item of items) {
        if (connection.lastSyncedCreatedAt && new Date(item.created_at) <= connection.lastSyncedCreatedAt) {
          break outer;
        }
        newFiles.push(item);
      }
      page += 1;
    }

    // Импортируем в хронологическом порядке (список пришёл newest-first).
    newFiles.reverse();

    const retryCutoff = new Date(Date.now() - RETRY_LOOKBACK_MS);
    const [pendingRetries, recentlySynced] = await Promise.all([
      this.prisma.plaudSyncItem.findMany({
        where: { employeeId, status: { in: [PlaudSyncStatus.WAITING_FOR_CONTENT, PlaudSyncStatus.FAILED] }, plaudCreatedAt: { gte: retryCutoff } },
      }),
      this.prisma.plaudSyncItem.findMany({
        where: { employeeId, status: PlaudSyncStatus.SYNCED, plaudCreatedAt: { gte: retryCutoff } },
      }),
    ]);

    let latestCreatedAt = connection.lastSyncedCreatedAt;
    for (const item of newFiles) {
      await this.syncItem(employeeId, item.id, item.name, item.created_at);
      // Курсор продвигается мимо КАЖДОЙ увиденной записи (даже
      // WAITING_FOR_CONTENT) — раньше это и было причиной бага #1, но
      // теперь PlaudSyncItem помнит её отдельно и pendingRetries выше
      // пересмотрит её на следующих прогонах независимо от курсора.
      latestCreatedAt = new Date(item.created_at);
    }
    for (const pending of pendingRetries) {
      await this.syncItem(employeeId, pending.plaudRecordingId, null, pending.plaudCreatedAt.toISOString());
    }
    for (const synced of recentlySynced) {
      await this.syncItem(employeeId, synced.plaudRecordingId, null, synced.plaudCreatedAt.toISOString());
    }

    await this.prisma.plaudConnection.update({
      where: { employeeId },
      data: { lastSyncedCreatedAt: latestCreatedAt, lastSyncAt: new Date() },
    });
  }

  // Единая точка для всех трёх источников работы (новая запись/ретрай
  // pending/перепроверка synced) — идемпотентна: без изменений на стороне
  // Plaud содержимое просто перезапишется тем же значением (contentHash
  // совпадёт, ранний return).
  private async syncItem(employeeId: string, plaudRecordingId: string, fallbackName: string | null, createdAtIso: string): Promise<void> {
    const tracking = await this.prisma.plaudSyncItem.findUnique({ where: { plaudRecordingId } });
    try {
      const detail = await this.api.getFile(employeeId, plaudRecordingId);
      const summaryNote = detail.note_list?.find((note) => note.data_type === 'auto_sum_note');
      if (!summaryNote) {
        await this.markStatus(employeeId, plaudRecordingId, createdAtIso, PlaudSyncStatus.WAITING_FOR_CONTENT);
        return;
      }

      const rawContent = await this.api.loadNoteContent(summaryNote);
      const rawSummary = stripImages(rawContent);
      if (!rawSummary) {
        await this.markStatus(employeeId, plaudRecordingId, createdAtIso, PlaudSyncStatus.WAITING_FOR_CONTENT);
        return;
      }

      const title = detail.name || fallbackName || 'Запись Plaud';
      const hash = contentHashOf(title, rawSummary);
      const contentUnchanged = tracking?.status === PlaudSyncStatus.SYNCED && tracking.contentHash === hash;

      if (contentUnchanged) {
        // Находка №3 пятого аудита (Stage 2, Phase L) — summary/title не
        // изменились, но транскрипт мог быть ещё не готов на момент прошлой
        // успешной синхронизации (contentHash после этого больше никогда не
        // меняется, а транскрипт — отдельная note в Plaud). transcriptSyncedAt
        // — независимый от contentHash признак: пока он null, пробуем
        // досинхронизировать транскрипт, не трогая уже синхронное summary.
        if (!tracking.transcriptSyncedAt && tracking.meetingId) {
          const transcriptSynced = await this.syncTranscriptSegments(tracking.meetingId, detail);
          if (transcriptSynced) {
            await this.prisma.plaudSyncItem.update({ where: { plaudRecordingId }, data: { transcriptSyncedAt: new Date() } });
          }
        }
        return;
      }

      // meetingId уже известен из tracking, либо (данные до Phase J —
      // Meeting импортирован, но PlaudSyncItem для него ещё не создан)
      // ищем по plaudRecordingId напрямую, как и раньше.
      const existingMeetingId = tracking?.meetingId ?? (await this.prisma.meeting.findUnique({ where: { plaudRecordingId }, select: { id: true } }))?.id;

      let meetingId: string;
      if (existingMeetingId) {
        // rawSummary НЕ обновляется — см. комментарий класса и сам
        // комментарий у Meeting.rawSummary в schema.prisma (раздел 8.1 ТЗ,
        // должна оставаться исходной версией для сверки).
        await this.prisma.meeting.update({ where: { id: existingMeetingId }, data: { title } });
        meetingId = existingMeetingId;
      } else {
        const created = await this.prisma.meeting.create({
          data: { title, meetingDate: new Date(createdAtIso), plaudRecordingId, rawSummary, createdById: employeeId },
        });
        meetingId = created.id;
      }

      const transcriptSynced = await this.syncTranscriptSegments(meetingId, detail);

      await this.prisma.plaudSyncItem.upsert({
        where: { plaudRecordingId },
        create: {
          employeeId,
          plaudRecordingId,
          plaudCreatedAt: new Date(createdAtIso),
          status: PlaudSyncStatus.SYNCED,
          meetingId,
          contentHash: hash,
          transcriptSyncedAt: transcriptSynced ? new Date() : null,
        },
        update: {
          status: PlaudSyncStatus.SYNCED,
          meetingId,
          contentHash: hash,
          lastAttemptAt: new Date(),
          errorMessage: null,
          // transcriptSyncedAt не сбрасывается в null, если этот прогон не
          // засинкал транскрипт заново (transcriptSynced=false) — иначе
          // изменение title/summary откатывало бы уже успешно
          // синхронизированный транскрипт обратно в "не синхронизирован".
          ...(transcriptSynced ? { transcriptSyncedAt: new Date() } : {}),
        },
      });
    } catch (err) {
      await this.prisma.plaudSyncItem.upsert({
        where: { plaudRecordingId },
        create: { employeeId, plaudRecordingId, plaudCreatedAt: new Date(createdAtIso), status: PlaudSyncStatus.FAILED, errorMessage: String(err) },
        update: { status: PlaudSyncStatus.FAILED, errorMessage: String(err), lastAttemptAt: new Date() },
      });
      this.logger.warn(`Не удалось синхронизировать запись Plaud ${plaudRecordingId}: ${err}`);
    }
  }

  private async markStatus(employeeId: string, plaudRecordingId: string, createdAtIso: string, status: PlaudSyncStatus): Promise<void> {
    await this.prisma.plaudSyncItem.upsert({
      where: { plaudRecordingId },
      create: { employeeId, plaudRecordingId, plaudCreatedAt: new Date(createdAtIso), status },
      update: { status, lastAttemptAt: new Date() },
    });
  }

  // Stage 2, Phase K — best-effort, см. предупреждение у
  // PlaudApiService.findTranscriptNote/parseTranscriptSegments: если
  // формат окажется неверным (findTranscriptNote ничего не находит,
  // JSON.parse не парсится), сегменты просто не появятся — не роняет
  // синхронизацию summary, которая уже успешно завершилась к этому
  // моменту. delete+createMany внутри транзакции — идемпотентно, старые
  // сегменты этой встречи не задваиваются при повторном прогоне.
  //
  // Возвращает true только если сегменты реально записаны — вызывающий код
  // (syncItem, Phase L) использует это, чтобы решить, можно ли пометить
  // transcriptSyncedAt: false здесь означает "транскрипт ещё не готов у
  // Plaud", а не "мы его синхронизировали и он пуст" — на следующем прогоне
  // нужно попробовать снова, а не считать вопрос закрытым.
  private async syncTranscriptSegments(meetingId: string, detail: PlaudFileDetail): Promise<boolean> {
    const note = this.api.findTranscriptNote(detail);
    if (!note) return false;
    const rawContent = await this.api.loadNoteContent(note);
    if (!rawContent) return false;
    const segments = parseTranscriptSegments(rawContent);
    if (segments.length === 0) return false;

    await this.prisma.$transaction([
      this.prisma.meetingSegment.deleteMany({ where: { meetingId } }),
      this.prisma.meetingSegment.createMany({
        data: segments.map((s) => ({ meetingId, order: s.order, startMs: s.startMs, endMs: s.endMs, speakerLabel: s.speakerLabel, text: s.text })),
      }),
    ]);
    return true;
  }
}
