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

function hashOf(content: string): string {
  return createHash('sha256').update(content).digest('hex');
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

  // Доп. P2-находка седьмого внешнего аудита ("targeted Plaud force-resync")
  // — pullChanges выше рассматривает запись только если она попадает в
  // курсор (новые файлы) или в RETRY_LOOKBACK_MS-окно (pendingRetries/
  // recentlySynced). Запись старше 7 дней, которую Plaud дообработал уже
  // после этого окна, никаким штатным прогоном крона больше не
  // пересматривается вовсе. forceSyncOne — точечный обход этой логики для
  // ОДНОЙ конкретной записи по явному запросу руководителя: те же самые
  // syncItem/contentHash-проверки (см. её комментарий — идемпотентна, если
  // содержимое реально не изменилось), просто без курсора/окна ретраев
  // вокруг них.
  async forceSyncOne(employeeId: string, plaudRecordingId: string): Promise<void> {
    const detail = await this.api.getFile(employeeId, plaudRecordingId);
    await this.syncItem(employeeId, plaudRecordingId, detail.name, detail.created_at);
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

      // Stage 2, Phase M (внешний аудит 21.09.2026, "transcript freshness
      // после первого успешного sync") — загружаем и хэшируем транскрипт
      // ОДИН раз здесь, независимо от того, изменилось ли summary: у Plaud
      // это отдельная note/source, меняется независимо. transcriptHash —
      // не просто "был ли синхронизирован хоть раз" (transcriptSyncedAt),
      // а "совпадает ли с тем, что мы видели в ПРОШЛЫЙ раз" — ловит и
      // случай "транскрипт был готов частично, потом Plaud его дописал".
      const transcript = await this.loadTranscriptContent(detail);

      if (contentUnchanged) {
        const transcriptChanged = transcript && transcript.hash !== tracking.transcriptHash;
        if (transcriptChanged && tracking.meetingId) {
          const transcriptSynced = await this.applyTranscriptSegments(tracking.meetingId, transcript.content);
          if (transcriptSynced) {
            await this.prisma.plaudSyncItem.update({
              where: { plaudRecordingId },
              data: { transcriptSyncedAt: new Date(), transcriptHash: transcript.hash },
            });
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
        // должна оставаться исходной версией для сверки). latestSummary —
        // находка №4 седьмого внешнего аудита (Stage 2, Phase N,
        // "Plaud summary freshness") — раньше новое содержимое здесь
        // просто отбрасывалось после обновления title; теперь сохраняем
        // его отдельно, не трогая замороженную rawSummary.
        await this.prisma.meeting.update({ where: { id: existingMeetingId }, data: { title, latestSummary: rawSummary } });
        meetingId = existingMeetingId;
      } else {
        const created = await this.prisma.meeting.create({
          data: { title, meetingDate: new Date(createdAtIso), plaudRecordingId, rawSummary, latestSummary: rawSummary, createdById: employeeId },
        });
        meetingId = created.id;
      }

      const transcriptSynced = transcript ? await this.applyTranscriptSegments(meetingId, transcript.content) : false;

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
          transcriptHash: transcriptSynced ? transcript!.hash : null,
        },
        update: {
          status: PlaudSyncStatus.SYNCED,
          meetingId,
          contentHash: hash,
          lastAttemptAt: new Date(),
          errorMessage: null,
          // transcriptSyncedAt/transcriptHash не сбрасываются, если этот
          // прогон не засинкал транскрипт заново (transcriptSynced=false)
          // — иначе изменение title/summary откатывало бы уже успешно
          // синхронизированный транскрипт обратно в "не синхронизирован".
          ...(transcriptSynced ? { transcriptSyncedAt: new Date(), transcriptHash: transcript!.hash } : {}),
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

  // Загружается ОДИН раз за вызов syncItem (см. её комментарий, Phase M) —
  // используется и веткой "summary не изменилось" (независимая проверка
  // транскрипта), и веткой "summary изменилось/новая запись", чтобы не
  // делать двойной запрос к Plaud/S3 за одним и тем же содержимым.
  private async loadTranscriptContent(detail: PlaudFileDetail): Promise<{ content: string; hash: string } | null> {
    const note = this.api.findTranscriptNote(detail);
    if (!note) return null;
    const content = await this.api.loadNoteContent(note);
    if (!content) return null;
    return { content, hash: hashOf(content) };
  }

  // Stage 2, Phase K — best-effort, см. предупреждение у
  // PlaudApiService.findTranscriptNote/parseTranscriptSegments: если
  // формат окажется неверным (JSON.parse не парсится), сегменты просто не
  // появятся — не роняет синхронизацию summary, которая уже успешно
  // завершилась к этому моменту. delete+createMany внутри транзакции —
  // идемпотентно, старые сегменты этой встречи не задваиваются при
  // повторном прогоне.
  //
  // Возвращает true только если сегменты реально записаны — вызывающий код
  // (syncItem) использует это, чтобы решить, можно ли пометить
  // transcriptSyncedAt/transcriptHash: false здесь означает "транскрипт
  // не распарсился", а не "мы его синхронизировали и он пуст" — на
  // следующем прогоне нужно попробовать снова, а не считать вопрос
  // закрытым.
  private async applyTranscriptSegments(meetingId: string, rawContent: string): Promise<boolean> {
    const segments = parseTranscriptSegments(rawContent);
    if (segments.length === 0) return false;

    // Находка №4 шестого внешнего аудита (Stage 2, Phase M) — delete+
    // createMany ниже полностью пересоздаёт сегменты этой встречи (resync
    // после того, как Plaud дописал/изменил транскрипт), а вместе с ними
    // раньше терялся уже проставленный руководителем speakerEmployeeId
    // (MeetingsService.updateSpeakers) — новые строки создавались с
    // speakerEmployeeId: null, и "Speaker 2 → Жандос" приходилось
    // сопоставлять заново после каждого resync'а. Читаем прежнее
    // сопоставление speakerLabel → speakerEmployeeId ДО удаления и
    // переносим его на новые сегменты с той же меткой.
    const previouslyMapped = await this.prisma.meetingSegment.findMany({
      where: { meetingId, speakerEmployeeId: { not: null } },
      select: { speakerLabel: true, speakerEmployeeId: true },
    });
    const speakerMapping = new Map(previouslyMapped.map((s) => [s.speakerLabel, s.speakerEmployeeId]));

    await this.prisma.$transaction([
      this.prisma.meetingSegment.deleteMany({ where: { meetingId } }),
      this.prisma.meetingSegment.createMany({
        data: segments.map((s) => ({
          meetingId,
          order: s.order,
          startMs: s.startMs,
          endMs: s.endMs,
          speakerLabel: s.speakerLabel,
          speakerEmployeeId: speakerMapping.get(s.speakerLabel) ?? null,
          text: s.text,
        })),
      }),
    ]);
    return true;
  }
}
