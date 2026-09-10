import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PlaudApiService, PlaudFileListItem } from './plaud-api.service';

const PAGE_SIZE = 20;

// Убираем декоративный постер записи (presigned-ссылка на картинку, живёт
// считанные минуты — незачем тащить битую ссылку в сохранённый markdown).
function stripImages(markdown: string): string {
  return markdown.replace(/!\[[^\]]*]\([^)]*\)\n?/g, '').trim();
}

// Синхронизация встреч из Plaud (владелец 08.09.2026) — переносит только
// саммари (auto_sum_note), транскрипт сознательно не храним (см. план).
// Курсор — created_at последней уже импортированной записи (у Plaud нет
// syncToken, как у Google Calendar; список файлов отдаётся newest-first).
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

    let latestCreatedAt = connection.lastSyncedCreatedAt;
    for (const item of newFiles) {
      try {
        await this.importFile(employeeId, item);
        latestCreatedAt = new Date(item.created_at);
      } catch (err) {
        this.logger.warn(`Не удалось импортировать запись Plaud ${item.id}: ${err}`);
      }
    }

    await this.prisma.plaudConnection.update({
      where: { employeeId },
      data: { lastSyncedCreatedAt: latestCreatedAt, lastSyncAt: new Date() },
    });
  }

  private async importFile(employeeId: string, item: PlaudFileListItem): Promise<void> {
    const existing = await this.prisma.meeting.findUnique({ where: { plaudRecordingId: item.id } });
    if (existing) return;

    const detail = await this.api.getFile(employeeId, item.id);
    const summaryNote = detail.note_list?.find((note) => note.data_type === 'auto_sum_note');
    if (!summaryNote) {
      this.logger.warn(`Запись Plaud ${item.id} без auto_sum_note — пропущена`);
      return;
    }

    const rawContent = await this.api.loadNoteContent(summaryNote);
    const rawSummary = stripImages(rawContent);
    if (!rawSummary) {
      this.logger.warn(`Запись Plaud ${item.id} — пустое саммари после обработки, пропущена`);
      return;
    }

    await this.prisma.meeting.create({
      data: {
        title: detail.name || item.name || 'Запись Plaud',
        meetingDate: new Date(item.created_at),
        plaudRecordingId: item.id,
        rawSummary,
        createdById: employeeId,
      },
    });
  }
}
