import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { TasksService } from '../tasks/tasks.service';
import { EmployeeResolverService } from '../employees/employee-resolver.service';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import type { CreateTaskDto } from '../tasks/dto/create-task.dto';
import { CreateMeetingDto } from './dto/create-meeting.dto';
import { MeetingTaskExtractionService } from './meeting-task-extraction.service';
import { SpeakerSubstitutionService } from './speaker-substitution.service';

const LIST_SELECT = {
  id: true,
  title: true,
  meetingDate: true,
  createdBy: { select: { id: true, fullName: true } },
  createdAt: true,
  plaudRecordingId: true,
} as const;

@Injectable()
export class MeetingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly tasks: TasksService,
    private readonly extraction: MeetingTaskExtractionService,
    private readonly speakerSubstitution: SpeakerSubstitutionService,
    private readonly employeeResolver: EmployeeResolverService,
  ) {}

  // roadmap v13, MUST-FIX #1 (23.09.2026) — "О чём последняя запись из
  // Plaud?" раньше мог выбрать вручную заведённую встречу вместо реальной
  // последней Plaud-записи, поскольку findAll() отдавал все Meeting без
  // разбора источника. source='plaud' фильтрует по уже существующему
  // Meeting.plaudRecordingId (заполняется только PlaudSyncService).
  // Единственный другой caller (MeetingsController → GET /meetings) не
  // передаёт аргумент — поведение для него не меняется.
  findAll(source: 'all' | 'plaud' = 'all') {
    return this.prisma.meeting.findMany({
      where: source === 'plaud' ? { plaudRecordingId: { not: null } } : undefined,
      select: LIST_SELECT,
      orderBy: { meetingDate: 'desc' },
    });
  }

  async findOne(id: string, viewerId: string) {
    const meeting = await this.prisma.meeting.findUnique({
      where: { id },
      select: {
        ...LIST_SELECT,
        rawSummary: true,
        // Находка №4 седьмого внешнего аудита (Stage 2, Phase N, "Plaud
        // summary freshness") — то, что Plaud реально отдаёт СЕЙЧАС,
        // независимо от замороженной rawSummary; используется ниже
        // потребителями саммари (Assistant/извлечение задач).
        latestSummary: true,
        enhancedSummary: true,
        speakerNames: true,
        audioUrl: true,
        tasks: {
          select: { id: true, title: true, status: true, sourceTimestamp: true },
        },
      },
    });
    if (!meeting) throw new NotFoundException('Встреча не найдена');

    // Раздел 15 ТЗ: аудит обращений к протоколам встреч, отдельно от их
    // содержимого.
    await this.audit.log(viewerId, 'READ', 'Meeting', id);
    return meeting;
  }

  create(dto: CreateMeetingDto, createdById: string) {
    return this.prisma.meeting.create({
      data: {
        title: dto.title,
        meetingDate: new Date(dto.meetingDate),
        rawSummary: dto.rawSummary,
        createdById,
      },
      select: LIST_SELECT,
    });
  }

  // "Speaker N" -> реальное имя (владелец 09.09.2026). Замена — через Claude,
  // не regex: наивная строковая подстановка ломает русские падежи ("по
  // мнению Speaker 2" -> "по мнению Иван" вместо "Ивана", найдено владельцем
  // при первой проверке) — модель понимает контекст предложения и склоняет
  // корректно (см. SpeakerSubstitutionService). enhancedSummary и так уже
  // показывается вместо rawSummary на экране встречи (findOne выше).
  async updateSpeakers(id: string, speakerNames: Record<string, string>) {
    const meeting = await this.prisma.meeting.findUnique({ where: { id }, select: { rawSummary: true } });
    if (!meeting) throw new NotFoundException('Встреча не найдена');

    const enhancedSummary = await this.speakerSubstitution.substitute(meeting.rawSummary, speakerNames);

    const updated = await this.prisma.meeting.update({
      where: { id },
      data: { speakerNames, enhancedSummary },
      select: LIST_SELECT,
    });

    // Best-effort, не должно мешать основному ответу (см. комментарий у
    // resolveSegmentSpeakers) — сбой здесь не откатывает уже сохранённые
    // speakerNames/enhancedSummary выше.
    await this.resolveSegmentSpeakers(id, speakerNames).catch(() => {});

    return updated;
  }

  // Находка №7 пятого внешнего аудита (Stage 2, Phase L) —
  // MeetingSegment.speakerEmployeeId существовал в схеме с Phase K, но ни
  // один код путь его не заполнял (найдено грепом: только объявление в
  // schema.prisma, ни одного присвоения). Тот же словарь "Speaker N" ->
  // реальное имя, что руководитель уже вводит здесь для enhancedSummary
  // (speakerNames), резолвится через EmployeeResolverService (та же
  // проверка по видимым ACTIVE-сотрудникам, что и у голосового
  // assigneeRawText) и пишется в сегменты транскрипта той же встречи.
  // AMBIGUOUS/NOT_FOUND — обычный, ожидаемый исход (введённое имя не
  // обязано совпасть ни с одним сотрудником, например внешний участник).
  //
  // Находка №5 шестого внешнего аудита (Stage 2, Phase M) — раньше
  // AMBIGUOUS/NOT_FOUND просто пропускался (`continue`), не трогая
  // speakerEmployeeId — если руководитель СНАЧАЛА привязал "Speaker 1" к
  // реальному сотруднику, а ПОТОМ исправил имя на то, что не резолвится
  // (например, внешний клиент), старый (уже неверный) speakerEmployeeId
  // оставался на сегментах навсегда. Явно сбрасываем в null при
  // AMBIGUOUS/NOT_FOUND — так неверный маппинг не переживает исправление.
  private async resolveSegmentSpeakers(meetingId: string, speakerNames: Record<string, string>): Promise<void> {
    const entries = Object.entries(speakerNames).filter(([, name]) => name && name.trim());
    if (entries.length === 0) return;

    const employees = await this.prisma.employee.findMany({ where: { status: 'ACTIVE' }, select: { id: true, fullName: true } });

    for (const [label, name] of entries) {
      const resolution = employees.length > 0 ? await this.employeeResolver.resolve(name, employees) : { status: 'NOT_FOUND' as const, employeeId: null };
      await this.prisma.meetingSegment.updateMany({
        where: { meetingId, speakerLabel: label },
        data: { speakerEmployeeId: resolution.status === 'RESOLVED' ? resolution.employeeId : null },
      });
    }
  }

  // Черновики эфемерны — ничего не пишем в БД здесь, только возвращаем
  // список (владелец 09.09.2026, тот же принцип, что VoiceService.parse).
  async extractTasks(id: string, viewerId: string) {
    const meeting = await this.prisma.meeting.findUnique({
      where: { id },
      select: { title: true, meetingDate: true, rawSummary: true, latestSummary: true, enhancedSummary: true },
    });
    if (!meeting) throw new NotFoundException('Встреча не найдена');

    const employees = await this.prisma.employee.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true, fullName: true },
    });

    // Находка №4 седьмого внешнего аудита (Stage 2, Phase N) — извлечение
    // задач должно смотреть на самую свежую версию саммари, не на
    // замороженную rawSummary, если Plaud её с тех пор обновил.
    const summary = meeting.enhancedSummary ?? meeting.latestSummary ?? meeting.rawSummary;
    const drafts = await this.extraction.extract(
      summary,
      meeting.title,
      meeting.meetingDate.toLocaleDateString('ru-RU'),
      employees,
    );

    await this.audit.log(viewerId, 'AI_EXTRACT', 'Meeting', id, { draftCount: drafts.length });

    return drafts.map((d) => ({
      ...d,
      assigneeName: d.assigneeId ? (employees.find((e) => e.id === d.assigneeId)?.fullName ?? null) : null,
    }));
  }

  // Подтверждённые руководителем в модалке черновики -> реальные задачи
  // (владелец 09.09.2026). sourceMeetingId — из :id в URL, а не из тела
  // запроса (тот же принцип защиты, что уже есть в TasksService.create()).
  // Переиспользуем create() целиком — RBAC/уведомления/проверки подзадач не
  // дублируются. Без общей транзакции на пачку — тот же уровень строгости,
  // что в tasks-overdue.cron.ts (по одному, без отката всех при ошибке одного).
  async createTasksFromMeeting(id: string, items: CreateTaskDto[], actor: AuthenticatedUser) {
    const exists = await this.prisma.meeting.findUnique({ where: { id }, select: { id: true } });
    if (!exists) throw new NotFoundException('Встреча не найдена');

    const created: Awaited<ReturnType<TasksService['create']>>[] = [];
    for (const item of items) {
      created.push(await this.tasks.create({ ...item, sourceMeetingId: id }, actor));
    }
    return created;
  }
}
