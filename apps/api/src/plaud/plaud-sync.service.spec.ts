import { createHash } from 'crypto';
import { PlaudSyncStatus } from '@prisma/client';
import { PlaudSyncService } from './plaud-sync.service';

function makeConnection(overrides: Partial<{ lastSyncedCreatedAt: Date | null }> = {}) {
  return { employeeId: 'emp1', lastSyncedCreatedAt: null, ...overrides };
}

function makeListResponse(items: { id: string; name: string; created_at: string }[]) {
  return { data: items };
}

function makeDetail(id: string, name: string, createdAt: string, summary: string | null) {
  return {
    id,
    name,
    created_at: createdAt,
    note_list: summary === null ? [] : [{ data_type: 'auto_sum_note', data_content: summary }],
  };
}

describe('PlaudSyncService.pullChanges', () => {
  it('нет подключения — ничего не делает, к API не обращается', async () => {
    const prisma = { plaudConnection: { findUnique: jest.fn().mockResolvedValue(null) } };
    const api = { listFiles: jest.fn() };
    const service = new PlaudSyncService(prisma as any, api as any);

    await service.pullChanges('emp1');

    expect(api.listFiles).not.toHaveBeenCalled();
  });

  it('новая запись с готовым summary — создаёт Meeting и PlaudSyncItem(SYNCED), продвигает курсор', async () => {
    const prisma = {
      plaudConnection: { findUnique: jest.fn().mockResolvedValue(makeConnection()), update: jest.fn() },
      plaudSyncItem: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn(),
      },
      meeting: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({ id: 'm1' }), update: jest.fn() },
    };
    const api = {
      listFiles: jest.fn().mockResolvedValueOnce(makeListResponse([{ id: 'p1', name: 'Встреча', created_at: '2026-09-01T10:00:00Z' }])).mockResolvedValueOnce(makeListResponse([])),
      getFile: jest.fn().mockResolvedValue(makeDetail('p1', 'Встреча', '2026-09-01T10:00:00Z', 'Саммари встречи')),
      loadNoteContent: jest.fn().mockImplementation((note: any) => Promise.resolve(note.data_content)),
      findTranscriptNote: jest.fn().mockReturnValue(undefined),
    };
    const service = new PlaudSyncService(prisma as any, api as any);

    await service.pullChanges('emp1');

    expect(prisma.meeting.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ title: 'Встреча', rawSummary: 'Саммари встречи', latestSummary: 'Саммари встречи', plaudRecordingId: 'p1' }) }),
    );
    expect(prisma.plaudSyncItem.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: expect.objectContaining({ status: PlaudSyncStatus.SYNCED, meetingId: 'm1' }) }),
    );
    expect(prisma.plaudConnection.update).toHaveBeenCalledWith({
      where: { employeeId: 'emp1' },
      data: { lastSyncedCreatedAt: new Date('2026-09-01T10:00:00Z'), lastSyncAt: expect.any(Date) },
    });
  });

  // Регрессия бага #1 (внешний аудит 21.09.2026): раньше запись без
  // готового summary терялась НАВСЕГДА, потому что курсор продвигался
  // мимо неё, а отдельной памяти "видели, но не синхронизировали" не было.
  it('РЕГРЕССИЯ бага #1 — запись без summary не теряется: следующий прогон подхватывает её из PlaudSyncItem, не из discovery по курсору', async () => {
    let trackingRow: any = null;
    const prisma = {
      plaudConnection: { findUnique: jest.fn().mockResolvedValue(makeConnection()), update: jest.fn() },
      plaudSyncItem: {
        findMany: jest.fn().mockImplementation(({ where }: any) =>
          Promise.resolve(trackingRow && where.status?.in?.includes(trackingRow.status) ? [trackingRow] : []),
        ),
        findUnique: jest.fn().mockImplementation(() => Promise.resolve(trackingRow)),
        upsert: jest.fn().mockImplementation(({ create, update }: any) => {
          trackingRow = trackingRow ? { ...trackingRow, ...update } : { plaudRecordingId: 'p1', ...create };
          return Promise.resolve(trackingRow);
        }),
      },
      meeting: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({ id: 'm1' }), update: jest.fn() },
    };
    const api = {
      listFiles: jest.fn(),
      getFile: jest.fn(),
      loadNoteContent: jest.fn().mockImplementation((note: any) => Promise.resolve(note.data_content)),
      findTranscriptNote: jest.fn().mockReturnValue(undefined),
    };
    const service = new PlaudSyncService(prisma as any, api as any);

    // Первый прогон: запись найдена, но summary ещё не готов.
    api.listFiles.mockResolvedValueOnce(makeListResponse([{ id: 'p1', name: 'Встреча', created_at: '2026-09-01T10:00:00Z' }])).mockResolvedValueOnce(makeListResponse([]));
    api.getFile.mockResolvedValueOnce(makeDetail('p1', 'Встреча', '2026-09-01T10:00:00Z', null));
    await service.pullChanges('emp1');

    expect(trackingRow.status).toBe(PlaudSyncStatus.WAITING_FOR_CONTENT);
    expect(prisma.meeting.create).not.toHaveBeenCalled();
    // Курсор всё равно продвинулся (как и раньше) — но теперь это не
    // теряет запись, а PlaudSyncItem её помнит отдельно.
    expect(prisma.plaudConnection.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ lastSyncedCreatedAt: new Date('2026-09-01T10:00:00Z') }) }),
    );

    // Второй прогон: список файлов от Plaud больше не содержит p1 (он
    // старше курсора, discovery его не найдёт) — но summary уже готов.
    api.listFiles.mockResolvedValueOnce(makeListResponse([])); // discovery: ничего нового
    api.getFile.mockResolvedValueOnce(makeDetail('p1', 'Встреча', '2026-09-01T10:00:00Z', 'Саммари готово'));
    await service.pullChanges('emp1');

    expect(prisma.meeting.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ rawSummary: 'Саммари готово' }) }));
    expect(trackingRow.status).toBe(PlaudSyncStatus.SYNCED);
  });

  // Регрессия бага #2: уже импортированная запись раньше никогда не
  // обновлялась при изменении содержимого на стороне Plaud. rawSummary
  // намеренно НЕ обновляется (см. комментарий в schema.prisma/сервисе —
  // раздел 8.1 ТЗ требует её неизменности), обновляется только title.
  //
  // РЕГРЕССИЯ находки №4 седьмого внешнего аудита (Stage 2, Phase N,
  // "Plaud summary freshness") — раньше новое содержимое здесь просто
  // отбрасывалось; теперь latestSummary отражает то, что Plaud реально
  // отдаёт сейчас, не дожидаясь ничего дополнительного.
  it('РЕГРЕССИЯ бага #2 / находки №4 седьмого аудита — изменившееся название и latestSummary обновляются, rawSummary НЕ трогается', async () => {
    const tracking = {
      plaudRecordingId: 'p1',
      status: PlaudSyncStatus.SYNCED,
      contentHash: 'old-hash',
      meetingId: 'm1',
      plaudCreatedAt: new Date('2026-09-01T10:00:00Z'),
    };
    const prisma = {
      plaudConnection: { findUnique: jest.fn().mockResolvedValue(makeConnection({ lastSyncedCreatedAt: new Date('2026-09-01T10:00:00Z') })), update: jest.fn() },
      plaudSyncItem: {
        findMany: jest.fn().mockImplementation(({ where }: any) => Promise.resolve(where.status === PlaudSyncStatus.SYNCED ? [tracking] : [])),
        findUnique: jest.fn().mockResolvedValue(tracking),
        upsert: jest.fn(),
      },
      meeting: { findUnique: jest.fn(), update: jest.fn().mockResolvedValue({}) },
    };
    const api = {
      listFiles: jest.fn().mockResolvedValue(makeListResponse([])),
      getFile: jest.fn().mockResolvedValue(makeDetail('p1', 'Новое название встречи', '2026-09-01T10:00:00Z', 'Саммари встречи')),
      loadNoteContent: jest.fn().mockImplementation((note: any) => Promise.resolve(note.data_content)),
      findTranscriptNote: jest.fn().mockReturnValue(undefined),
    };
    const service = new PlaudSyncService(prisma as any, api as any);

    await service.pullChanges('emp1');

    expect(prisma.meeting.update).toHaveBeenCalledWith({ where: { id: 'm1' }, data: { title: 'Новое название встречи', latestSummary: 'Саммари встречи' } });
    expect(prisma.meeting.update).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ rawSummary: expect.anything() }) }));
  });

  it('содержимое не изменилось (тот же contentHash) — Meeting.update не вызывается вовсе', async () => {
    const rawSummary = 'Саммари встречи';
    const title = 'Встреча';
    const hash = createHash('sha256').update(`${title}\n${rawSummary}`).digest('hex');
    const tracking = { plaudRecordingId: 'p1', status: PlaudSyncStatus.SYNCED, contentHash: hash, meetingId: 'm1', plaudCreatedAt: new Date('2026-09-01T10:00:00Z') };
    const prisma = {
      plaudConnection: { findUnique: jest.fn().mockResolvedValue(makeConnection({ lastSyncedCreatedAt: new Date('2026-09-01T10:00:00Z') })), update: jest.fn() },
      plaudSyncItem: {
        findMany: jest.fn().mockImplementation(({ where }: any) => Promise.resolve(where.status === PlaudSyncStatus.SYNCED ? [tracking] : [])),
        findUnique: jest.fn().mockResolvedValue(tracking),
        upsert: jest.fn(),
      },
      meeting: { findUnique: jest.fn(), update: jest.fn() },
    };
    const api = {
      listFiles: jest.fn().mockResolvedValue(makeListResponse([])),
      getFile: jest.fn().mockResolvedValue(makeDetail('p1', title, '2026-09-01T10:00:00Z', rawSummary)),
      loadNoteContent: jest.fn().mockImplementation((note: any) => Promise.resolve(note.data_content)),
      findTranscriptNote: jest.fn().mockReturnValue(undefined),
    };
    const service = new PlaudSyncService(prisma as any, api as any);

    await service.pullChanges('emp1');

    expect(prisma.meeting.update).not.toHaveBeenCalled();
    expect(prisma.plaudSyncItem.upsert).not.toHaveBeenCalled();
  });

  it('сбой API при синхронизации одной записи — помечается FAILED, не роняет весь прогон (остальные записи обрабатываются)', async () => {
    const prisma = {
      plaudConnection: { findUnique: jest.fn().mockResolvedValue(makeConnection()), update: jest.fn() },
      plaudSyncItem: { findMany: jest.fn().mockResolvedValue([]), findUnique: jest.fn().mockResolvedValue(null), upsert: jest.fn() },
      meeting: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({ id: 'm2' }), update: jest.fn() },
    };
    const api = {
      listFiles: jest
        .fn()
        .mockResolvedValueOnce(
          // Plaud отдаёт newest-first — сервис делает .reverse(), поэтому
          // здесь порядок p2 (новее), затем p1 (старее), чтобы после
          // reverse() p1 обрабатывался первым (соответствует порядку
          // моков getFile ниже: сбой затем успех).
          makeListResponse([
            { id: 'p2', name: 'Успешная', created_at: '2026-09-01T11:00:00Z' },
            { id: 'p1', name: 'Сбойная', created_at: '2026-09-01T10:00:00Z' },
          ]),
        )
        .mockResolvedValueOnce(makeListResponse([])),
      getFile: jest.fn().mockRejectedValueOnce(new Error('Plaud API недоступен')).mockResolvedValueOnce(makeDetail('p2', 'Успешная', '2026-09-01T11:00:00Z', 'Саммари')),
      loadNoteContent: jest.fn().mockImplementation((note: any) => Promise.resolve(note.data_content)),
      findTranscriptNote: jest.fn().mockReturnValue(undefined),
    };
    const service = new PlaudSyncService(prisma as any, api as any);

    await service.pullChanges('emp1');

    expect(prisma.plaudSyncItem.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { plaudRecordingId: 'p1' }, create: expect.objectContaining({ status: PlaudSyncStatus.FAILED }) }),
    );
    expect(prisma.meeting.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ plaudRecordingId: 'p2' }) }));
  });

  it('данные до Phase J (Meeting импортирован, PlaudSyncItem ещё не создан) — досоздаёт tracking, обновляет только title', async () => {
    const prisma = {
      plaudConnection: { findUnique: jest.fn().mockResolvedValue(makeConnection({ lastSyncedCreatedAt: new Date('2026-09-01T10:00:00Z') })), update: jest.fn() },
      plaudSyncItem: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null), // ещё нет tracking-строки
        upsert: jest.fn(),
      },
      meeting: { findUnique: jest.fn().mockResolvedValue({ id: 'm-legacy' }), create: jest.fn(), update: jest.fn().mockResolvedValue({}) },
    };
    const api = {
      listFiles: jest.fn().mockResolvedValue(makeListResponse([])),
      getFile: jest.fn().mockResolvedValue(makeDetail('p-legacy', 'Обновлённое название', '2026-08-01T10:00:00Z', 'Саммари')),
      loadNoteContent: jest.fn().mockImplementation((note: any) => Promise.resolve(note.data_content)),
      findTranscriptNote: jest.fn().mockReturnValue(undefined),
    };
    // Ретрай-путь здесь не задействован (нет pending/synced tracking) — но
    // syncItem всё равно способен обработать легаси-запись, если её вызвать
    // напрямую (например, через будущий backfill) — используем privately
    // через тот же путь: findMany пустой, значит этот тест на самом деле
    // проверяет только findUnique-фолбэк — тестируем непосредственно через
    // discovery, где p-legacy встречается как "новая" запись.
    api.listFiles.mockResolvedValueOnce(makeListResponse([{ id: 'p-legacy', name: 'Обновлённое название', created_at: '2026-09-02T10:00:00Z' }])).mockResolvedValueOnce(makeListResponse([]));
    const service = new PlaudSyncService(prisma as any, api as any);

    await service.pullChanges('emp1');

    expect(prisma.meeting.update).toHaveBeenCalledWith({ where: { id: 'm-legacy' }, data: { title: 'Обновлённое название', latestSummary: 'Саммари' } });
    expect(prisma.meeting.create).not.toHaveBeenCalled();
    expect(prisma.plaudSyncItem.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: expect.objectContaining({ meetingId: 'm-legacy', status: PlaudSyncStatus.SYNCED }) }),
    );
  });

  // Stage 2, Phase K (внешний аудит 21.09.2026, "MeetingSegment +
  // transcript ingestion") — best-effort, см. предупреждение в
  // plaud-api.service.ts/transcript-parser.ts. Здесь тестируется только
  // то, что этот сервис делает С УЖЕ РАСПАРШЕННЫМИ сегментами
  // (parseTranscriptSegments протестирован отдельно) — не реальный формат
  // Plaud API.
  describe('транскрипт (best-effort, см. предупреждение в plaud-api.service.ts)', () => {
    function baseMocks() {
      const prisma = {
        plaudConnection: { findUnique: jest.fn().mockResolvedValue(makeConnection()), update: jest.fn() },
        plaudSyncItem: { findMany: jest.fn().mockResolvedValue([]), findUnique: jest.fn().mockResolvedValue(null), upsert: jest.fn() },
        meeting: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({ id: 'm1' }), update: jest.fn() },
        meetingSegment: { deleteMany: jest.fn(), createMany: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
        $transaction: jest.fn((ops: any[]) => Promise.all(ops)),
      };
      const api = {
        listFiles: jest.fn().mockResolvedValueOnce(makeListResponse([{ id: 'p1', name: 'Встреча', created_at: '2026-09-01T10:00:00Z' }])).mockResolvedValueOnce(makeListResponse([])),
        loadNoteContent: jest.fn(),
        findTranscriptNote: jest.fn(),
        getFile: jest.fn().mockResolvedValue(makeDetail('p1', 'Встреча', '2026-09-01T10:00:00Z', 'Саммари встречи')),
      };
      return { prisma, api };
    }

    it('транскрипт-note не найден — MeetingSegment не трогается, summary всё равно синхронизируется', async () => {
      const { prisma, api } = baseMocks();
      api.findTranscriptNote.mockReturnValue(undefined);
      api.loadNoteContent.mockImplementation((note: any) => Promise.resolve(note.data_content));
      const service = new PlaudSyncService(prisma as any, api as any);

      await service.pullChanges('emp1');

      expect(prisma.meeting.create).toHaveBeenCalled();
      expect(prisma.meetingSegment.createMany).not.toHaveBeenCalled();
    });

    it('транскрипт-note найден и парсится — сохраняет сегменты (delete+createMany в транзакции)', async () => {
      const { prisma, api } = baseMocks();
      const transcriptNote = { data_type: 'origin_text_note', data_content: JSON.stringify([{ speaker: 'A', start: 0, end: 2, text: 'Привет' }]) };
      api.findTranscriptNote.mockReturnValue(transcriptNote);
      api.loadNoteContent.mockImplementation((note: any) => Promise.resolve(note.data_content));
      const service = new PlaudSyncService(prisma as any, api as any);

      await service.pullChanges('emp1');

      expect(prisma.meetingSegment.deleteMany).toHaveBeenCalledWith({ where: { meetingId: 'm1' } });
      expect(prisma.meetingSegment.createMany).toHaveBeenCalledWith({
        data: [{ meetingId: 'm1', order: 0, startMs: 0, endMs: 2000, speakerLabel: 'A', speakerEmployeeId: null, text: 'Привет' }],
      });
    });

    it('транскрипт-note найден, но не парсится (неожиданный формат) — не бросает, summary всё равно синхронизируется', async () => {
      const { prisma, api } = baseMocks();
      const transcriptNote = { data_type: 'origin_text_note', data_content: 'совсем не тот формат' };
      api.findTranscriptNote.mockReturnValue(transcriptNote);
      api.loadNoteContent.mockImplementation((note: any) => Promise.resolve(note.data_content));
      const service = new PlaudSyncService(prisma as any, api as any);

      await expect(service.pullChanges('emp1')).resolves.not.toThrow();

      expect(prisma.meeting.create).toHaveBeenCalled();
      expect(prisma.meetingSegment.createMany).not.toHaveBeenCalled();
    });

    // Находка №3 пятого внешнего аудита (Stage 2, Phase L) — раньше
    // contentUnchanged просто делал `return`, и транскрипт, не готовый на
    // момент первой успешной синхронизации summary, не подхватывался
    // НИКОГДА (contentHash после этого больше не меняется). transcriptSyncedAt
    // — независимый признак: пока он null, транскрипт пробуем досинхронизировать
    // даже когда summary/title не изменились.
    it('РЕГРЕССИЯ находки №3 — summary не изменилось, но transcriptSyncedAt=null → транскрипт всё равно досинхронизируется', async () => {
      const rawSummary = 'Саммари встречи';
      const title = 'Встреча';
      const hash = createHash('sha256').update(`${title}\n${rawSummary}`).digest('hex');
      const tracking = {
        plaudRecordingId: 'p1',
        status: PlaudSyncStatus.SYNCED,
        contentHash: hash,
        meetingId: 'm1',
        transcriptSyncedAt: null,
        plaudCreatedAt: new Date('2026-09-01T10:00:00Z'),
      };
      const prisma = {
        plaudConnection: { findUnique: jest.fn().mockResolvedValue(makeConnection({ lastSyncedCreatedAt: new Date('2026-09-01T10:00:00Z') })), update: jest.fn() },
        plaudSyncItem: {
          findMany: jest.fn().mockImplementation(({ where }: any) => Promise.resolve(where.status === PlaudSyncStatus.SYNCED ? [tracking] : [])),
          findUnique: jest.fn().mockResolvedValue(tracking),
          update: jest.fn(),
          upsert: jest.fn(),
        },
        meeting: { findUnique: jest.fn(), update: jest.fn() },
        meetingSegment: { deleteMany: jest.fn(), createMany: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
        $transaction: jest.fn((ops: any[]) => Promise.all(ops)),
      };
      const transcriptNote = { data_type: 'origin_text_note', data_content: JSON.stringify([{ speaker: 'A', start: 0, end: 2, text: 'Привет' }]) };
      const api = {
        listFiles: jest.fn().mockResolvedValue(makeListResponse([])),
        getFile: jest.fn().mockResolvedValue(makeDetail('p1', title, '2026-09-01T10:00:00Z', rawSummary)),
        loadNoteContent: jest.fn().mockImplementation((note: any) => Promise.resolve(note.data_content)),
        findTranscriptNote: jest.fn().mockReturnValue(transcriptNote),
      };
      const service = new PlaudSyncService(prisma as any, api as any);

      await service.pullChanges('emp1');

      // Summary-путь не тронут — ни meeting.update, ни plaudSyncItem.upsert
      // (contentHash не изменился, title тот же).
      expect(prisma.meeting.update).not.toHaveBeenCalled();
      expect(prisma.plaudSyncItem.upsert).not.toHaveBeenCalled();
      // Но транскрипт синхронизирован и transcriptSyncedAt проставлен.
      expect(prisma.meetingSegment.createMany).toHaveBeenCalledWith({
        data: [{ meetingId: 'm1', order: 0, startMs: 0, endMs: 2000, speakerLabel: 'A', speakerEmployeeId: null, text: 'Привет' }],
      });
      expect(prisma.plaudSyncItem.update).toHaveBeenCalledWith({
        where: { plaudRecordingId: 'p1' },
        data: { transcriptSyncedAt: expect.any(Date), transcriptHash: expect.any(String) },
      });
    });

    it('содержимое (summary) не изменилось, транскрипт тоже не изменился (совпадает transcriptHash) — не пересинхронизируется', async () => {
      const rawSummary = 'Саммари встречи';
      const title = 'Встреча';
      const hash = createHash('sha256').update(`${title}\n${rawSummary}`).digest('hex');
      const transcriptContent = JSON.stringify([{ speaker: 'A', start_time: 0, end_time: 2000, content: 'Привет' }]);
      const transcriptHash = createHash('sha256').update(transcriptContent).digest('hex');
      const tracking = {
        plaudRecordingId: 'p1',
        status: PlaudSyncStatus.SYNCED,
        contentHash: hash,
        meetingId: 'm1',
        transcriptSyncedAt: new Date('2026-09-01T10:05:00Z'),
        transcriptHash,
        plaudCreatedAt: new Date('2026-09-01T10:00:00Z'),
      };
      const prisma = {
        plaudConnection: { findUnique: jest.fn().mockResolvedValue(makeConnection({ lastSyncedCreatedAt: new Date('2026-09-01T10:00:00Z') })), update: jest.fn() },
        plaudSyncItem: {
          findMany: jest.fn().mockImplementation(({ where }: any) => Promise.resolve(where.status === PlaudSyncStatus.SYNCED ? [tracking] : [])),
          findUnique: jest.fn().mockResolvedValue(tracking),
          update: jest.fn(),
          upsert: jest.fn(),
        },
        meeting: { findUnique: jest.fn(), update: jest.fn() },
        meetingSegment: { deleteMany: jest.fn(), createMany: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
        $transaction: jest.fn((ops: any[]) => Promise.all(ops)),
      };
      const transcriptNote = { data_type: 'origin_text_note', data_content: transcriptContent };
      const api = {
        listFiles: jest.fn().mockResolvedValue(makeListResponse([])),
        getFile: jest.fn().mockResolvedValue(makeDetail('p1', title, '2026-09-01T10:00:00Z', rawSummary)),
        loadNoteContent: jest.fn().mockImplementation((note: any) => Promise.resolve(note.data_content)),
        findTranscriptNote: jest.fn().mockReturnValue(transcriptNote),
      };
      const service = new PlaudSyncService(prisma as any, api as any);

      await service.pullChanges('emp1');

      // findTranscriptNote/loadNoteContent теперь ВСЕГДА вызываются (нужно
      // посчитать текущий хэш для сравнения) — но раз он совпал с
      // сохранённым, ни пересохранение сегментов, ни upsert не происходят.
      expect(prisma.meetingSegment.createMany).not.toHaveBeenCalled();
      expect(prisma.plaudSyncItem.update).not.toHaveBeenCalled();
    });

    // РЕГРЕССИЯ находки шестого внешнего аудита (Stage 2, Phase M,
    // "transcript freshness после первого успешного sync") — раньше
    // transcriptSyncedAt, однажды выставленный, НАВСЕГДА блокировал
    // повторную проверку транскрипта, даже если Plaud его потом дописал
    // (например, запись была ещё не до конца обработана на момент первого
    // успешного sync). transcriptHash ловит именно этот случай — сравнение
    // содержимого, а не факта "хоть раз синхронизировали".
    it('РЕГРЕССИЯ находки шестого аудита — транскрипт вырос после первого успешного sync (summary не менялось) → пересинхронизируется', async () => {
      const rawSummary = 'Саммари встречи';
      const title = 'Встреча';
      const hash = createHash('sha256').update(`${title}\n${rawSummary}`).digest('hex');
      const oldTranscriptContent = JSON.stringify([{ speaker: 'A', start_time: 0, end_time: 2000, content: 'Привет' }]);
      const oldTranscriptHash = createHash('sha256').update(oldTranscriptContent).digest('hex');
      const tracking = {
        plaudRecordingId: 'p1',
        status: PlaudSyncStatus.SYNCED,
        contentHash: hash,
        meetingId: 'm1',
        transcriptSyncedAt: new Date('2026-09-01T10:05:00Z'),
        transcriptHash: oldTranscriptHash,
        plaudCreatedAt: new Date('2026-09-01T10:00:00Z'),
      };
      const prisma = {
        plaudConnection: { findUnique: jest.fn().mockResolvedValue(makeConnection({ lastSyncedCreatedAt: new Date('2026-09-01T10:00:00Z') })), update: jest.fn() },
        plaudSyncItem: {
          findMany: jest.fn().mockImplementation(({ where }: any) => Promise.resolve(where.status === PlaudSyncStatus.SYNCED ? [tracking] : [])),
          findUnique: jest.fn().mockResolvedValue(tracking),
          update: jest.fn(),
          upsert: jest.fn(),
        },
        meeting: { findUnique: jest.fn(), update: jest.fn() },
        meetingSegment: { deleteMany: jest.fn(), createMany: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
        $transaction: jest.fn((ops: any[]) => Promise.all(ops)),
      };
      // Plaud дописал транскрипт — теперь два сегмента вместо одного,
      // содержимое (и, соответственно, хэш) реально изменилось.
      const newTranscriptContent = JSON.stringify([
        { speaker: 'A', start_time: 0, end_time: 2000, content: 'Привет' },
        { speaker: 'B', start_time: 2000, end_time: 4000, content: 'Добрый день' },
      ]);
      const transcriptNote = { data_type: 'origin_text_note', data_content: newTranscriptContent };
      const api = {
        listFiles: jest.fn().mockResolvedValue(makeListResponse([])),
        getFile: jest.fn().mockResolvedValue(makeDetail('p1', title, '2026-09-01T10:00:00Z', rawSummary)),
        loadNoteContent: jest.fn().mockImplementation((note: any) => Promise.resolve(note.data_content)),
        findTranscriptNote: jest.fn().mockReturnValue(transcriptNote),
      };
      const service = new PlaudSyncService(prisma as any, api as any);

      await service.pullChanges('emp1');

      expect(prisma.meetingSegment.createMany).toHaveBeenCalledWith({
        data: [
          { meetingId: 'm1', order: 0, startMs: 0, endMs: 2000, speakerLabel: 'A', speakerEmployeeId: null, text: 'Привет' },
          { meetingId: 'm1', order: 1, startMs: 2000, endMs: 4000, speakerLabel: 'B', speakerEmployeeId: null, text: 'Добрый день' },
        ],
      });
      expect(prisma.plaudSyncItem.update).toHaveBeenCalledWith({
        where: { plaudRecordingId: 'p1' },
        data: { transcriptSyncedAt: expect.any(Date), transcriptHash: expect.any(String) },
      });
    });

    it('summary изменилось (новый contentHash) и транскрипт синхронизирован — upsert выставляет transcriptSyncedAt', async () => {
      const tracking = {
        plaudRecordingId: 'p1',
        status: PlaudSyncStatus.SYNCED,
        contentHash: 'old-hash',
        meetingId: 'm1',
        transcriptSyncedAt: null,
        plaudCreatedAt: new Date('2026-09-01T10:00:00Z'),
      };
      const prisma = {
        plaudConnection: { findUnique: jest.fn().mockResolvedValue(makeConnection({ lastSyncedCreatedAt: new Date('2026-09-01T10:00:00Z') })), update: jest.fn() },
        plaudSyncItem: {
          findMany: jest.fn().mockImplementation(({ where }: any) => Promise.resolve(where.status === PlaudSyncStatus.SYNCED ? [tracking] : [])),
          findUnique: jest.fn().mockResolvedValue(tracking),
          update: jest.fn(),
          upsert: jest.fn(),
        },
        meeting: { findUnique: jest.fn(), update: jest.fn().mockResolvedValue({}) },
        meetingSegment: { deleteMany: jest.fn(), createMany: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
        $transaction: jest.fn((ops: any[]) => Promise.all(ops)),
      };
      const transcriptNote = { data_type: 'origin_text_note', data_content: JSON.stringify([{ speaker: 'A', start: 0, end: 2, text: 'Привет' }]) };
      const api = {
        listFiles: jest.fn().mockResolvedValue(makeListResponse([])),
        getFile: jest.fn().mockResolvedValue(makeDetail('p1', 'Новое название', '2026-09-01T10:00:00Z', 'Новое саммари')),
        loadNoteContent: jest.fn().mockImplementation((note: any) => Promise.resolve(note.data_content)),
        findTranscriptNote: jest.fn().mockReturnValue(transcriptNote),
      };
      const service = new PlaudSyncService(prisma as any, api as any);

      await service.pullChanges('emp1');

      expect(prisma.plaudSyncItem.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ update: expect.objectContaining({ transcriptSyncedAt: expect.any(Date) }) }),
      );
    });

    // РЕГРЕССИЯ находки №4 шестого внешнего аудита (Stage 2, Phase M) —
    // раньше delete+createMany при ресинке транскрипта (например, Plaud
    // дописал запись) полностью стирало уже проставленный руководителем
    // speakerEmployeeId ("Speaker 2" → Жандос) — новые строки создавались
    // с speakerEmployeeId: null, сопоставление приходилось делать заново
    // после каждого resync'а.
    it('РЕГРЕССИЯ находки №4 шестого аудита — resync транскрипта сохраняет ранее проставленный speakerEmployeeId по speakerLabel', async () => {
      const rawSummary = 'Саммари встречи';
      const title = 'Встреча';
      const hash = createHash('sha256').update(`${title}\n${rawSummary}`).digest('hex');
      const oldTranscriptContent = JSON.stringify([{ speaker: 'Speaker 2', start_time: 0, end_time: 2000, content: 'Привет' }]);
      const oldTranscriptHash = createHash('sha256').update(oldTranscriptContent).digest('hex');
      const tracking = {
        plaudRecordingId: 'p1',
        status: PlaudSyncStatus.SYNCED,
        contentHash: hash,
        meetingId: 'm1',
        transcriptSyncedAt: new Date('2026-09-01T10:05:00Z'),
        transcriptHash: oldTranscriptHash,
        plaudCreatedAt: new Date('2026-09-01T10:00:00Z'),
      };
      const prisma = {
        plaudConnection: { findUnique: jest.fn().mockResolvedValue(makeConnection({ lastSyncedCreatedAt: new Date('2026-09-01T10:00:00Z') })), update: jest.fn() },
        plaudSyncItem: {
          findMany: jest.fn().mockImplementation(({ where }: any) => Promise.resolve(where.status === PlaudSyncStatus.SYNCED ? [tracking] : [])),
          findUnique: jest.fn().mockResolvedValue(tracking),
          update: jest.fn(),
          upsert: jest.fn(),
        },
        meeting: { findUnique: jest.fn(), update: jest.fn() },
        meetingSegment: {
          deleteMany: jest.fn(),
          createMany: jest.fn(),
          // Уже проставленное руководителем сопоставление до ресинка.
          findMany: jest.fn().mockResolvedValue([{ speakerLabel: 'Speaker 2', speakerEmployeeId: 'e1' }]),
        },
        $transaction: jest.fn((ops: any[]) => Promise.all(ops)),
      };
      // Plaud дописал транскрипт — новый сегмент с той же меткой "Speaker 2".
      const newTranscriptContent = JSON.stringify([
        { speaker: 'Speaker 2', start_time: 0, end_time: 2000, content: 'Привет' },
        { speaker: 'Speaker 2', start_time: 2000, end_time: 4000, content: 'Как дела' },
      ]);
      const transcriptNote = { data_type: 'origin_text_note', data_content: newTranscriptContent };
      const api = {
        listFiles: jest.fn().mockResolvedValue(makeListResponse([])),
        getFile: jest.fn().mockResolvedValue(makeDetail('p1', title, '2026-09-01T10:00:00Z', rawSummary)),
        loadNoteContent: jest.fn().mockImplementation((note: any) => Promise.resolve(note.data_content)),
        findTranscriptNote: jest.fn().mockReturnValue(transcriptNote),
      };
      const service = new PlaudSyncService(prisma as any, api as any);

      await service.pullChanges('emp1');

      expect(prisma.meetingSegment.createMany).toHaveBeenCalledWith({
        data: [
          { meetingId: 'm1', order: 0, startMs: 0, endMs: 2000, speakerLabel: 'Speaker 2', speakerEmployeeId: 'e1', text: 'Привет' },
          { meetingId: 'm1', order: 1, startMs: 2000, endMs: 4000, speakerLabel: 'Speaker 2', speakerEmployeeId: 'e1', text: 'Как дела' },
        ],
      });
    });
  });
});

// Доп. P2-находка седьмого внешнего аудита ("targeted Plaud force-resync")
// — pullChanges выше рассматривает запись, только если она попадает в
// курсор (новые файлы) или в RETRY_LOOKBACK_MS-окно (7 дней). forceSyncOne
// должен пересинхронизировать ОДНУ запись в обход и того, и другого — без
// обращения к plaudConnection/listFiles вообще, единственный API-вызов —
// getFile по явно переданному recordingId.
describe('PlaudSyncService.forceSyncOne — точечный force-resync (доп. P2-находка седьмого аудита)', () => {
  it('не трогает plaudConnection/listFiles — обходит курсор и RETRY_LOOKBACK_MS-окно полностью', async () => {
    const rawSummary = 'Обновлённое саммари';
    const title = 'Старая встреча';
    // Запись синхронизирована 30 дней назад — далеко за пределами
    // RETRY_LOOKBACK_MS (7 дней), обычный /sync её бы уже не пересмотрел.
    const staleContentHash = createHash('sha256').update(`${title}\nстарое саммари`).digest('hex');
    const tracking = {
      plaudRecordingId: 'p1',
      status: PlaudSyncStatus.SYNCED,
      contentHash: staleContentHash,
      meetingId: 'm1',
      plaudCreatedAt: new Date('2026-08-01T10:00:00Z'),
    };
    const prisma = {
      plaudConnection: { findUnique: jest.fn(), update: jest.fn() },
      plaudSyncItem: { findUnique: jest.fn().mockResolvedValue(tracking), upsert: jest.fn() },
      meeting: { findUnique: jest.fn(), update: jest.fn().mockResolvedValue({ id: 'm1' }) },
    };
    const api = {
      listFiles: jest.fn(),
      getFile: jest.fn().mockResolvedValue(makeDetail('p1', title, '2026-08-01T10:00:00Z', rawSummary)),
      loadNoteContent: jest.fn().mockImplementation((note: any) => Promise.resolve(note.data_content)),
      findTranscriptNote: jest.fn().mockReturnValue(undefined),
    };
    const service = new PlaudSyncService(prisma as any, api as any);

    await service.forceSyncOne('emp1', 'p1');

    expect(prisma.plaudConnection.findUnique).not.toHaveBeenCalled();
    expect(api.listFiles).not.toHaveBeenCalled();
    expect(api.getFile).toHaveBeenCalledWith('emp1', 'p1');
    expect(prisma.meeting.update).toHaveBeenCalledWith({
      where: { id: 'm1' },
      data: { title, latestSummary: rawSummary },
    });
  });

  it('содержимое реально не изменилось — идемпотентна, ничего не перезаписывает (та же contentHash-проверка, что у syncItem)', async () => {
    const rawSummary = 'Саммари без изменений';
    const title = 'Встреча';
    const hash = createHash('sha256').update(`${title}\n${rawSummary}`).digest('hex');
    const tracking = { plaudRecordingId: 'p1', status: PlaudSyncStatus.SYNCED, contentHash: hash, meetingId: 'm1', plaudCreatedAt: new Date('2026-08-01T10:00:00Z') };
    const prisma = {
      plaudSyncItem: { findUnique: jest.fn().mockResolvedValue(tracking), upsert: jest.fn() },
      meeting: { findUnique: jest.fn(), update: jest.fn() },
    };
    const api = {
      getFile: jest.fn().mockResolvedValue(makeDetail('p1', title, '2026-08-01T10:00:00Z', rawSummary)),
      loadNoteContent: jest.fn().mockImplementation((note: any) => Promise.resolve(note.data_content)),
      findTranscriptNote: jest.fn().mockReturnValue(undefined),
    };
    const service = new PlaudSyncService(prisma as any, api as any);

    await service.forceSyncOne('emp1', 'p1');

    expect(prisma.meeting.update).not.toHaveBeenCalled();
  });

  it('запись никогда не была синхронизирована (нет PlaudSyncItem) — создаёт Meeting напрямую, минуя pullChanges', async () => {
    const prisma = {
      plaudSyncItem: { findUnique: jest.fn().mockResolvedValue(null), upsert: jest.fn() },
      meeting: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({ id: 'm-new' }) },
    };
    const api = {
      getFile: jest.fn().mockResolvedValue(makeDetail('p2', 'Новая встреча', '2026-09-20T10:00:00Z', 'Саммари')),
      loadNoteContent: jest.fn().mockImplementation((note: any) => Promise.resolve(note.data_content)),
      findTranscriptNote: jest.fn().mockReturnValue(undefined),
    };
    const service = new PlaudSyncService(prisma as any, api as any);

    await service.forceSyncOne('emp1', 'p2');

    expect(prisma.meeting.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ title: 'Новая встреча', rawSummary: 'Саммари', plaudRecordingId: 'p2' }) }),
    );
  });
});
