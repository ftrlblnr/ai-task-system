import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { MeetingAnalysisStatus, MeetingProposalStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { TasksService } from '../tasks/tasks.service';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { MeetingAnalysisService } from './meeting-analysis.service';
import { parseLocalDue } from './meeting-task-extraction.service';
import type { ApproveProposalItemDto } from './dto/meeting-proposals.dto';

// Поручения из встреч — утверждение (AGENT_AND_MEETINGS.md, B.5). Задача
// появляется только здесь, по решению руководителя, обычным
// TasksService.create: RBAC, история и «Вам назначена задача» исполнителю —
// как у любой задачи.

const PROPOSAL_SELECT = {
  id: true,
  status: true,
  version: true,
  order: true,
  title: true,
  description: true,
  assigneeRawText: true,
  dueDate: true,
  priority: true,
  confidence: true,
  sourceContext: true,
  sourceTimestamp: true,
  assignee: { select: { id: true, fullName: true } },
  similarTask: { select: { id: true, title: true, status: true } },
  task: { select: { id: true, title: true, status: true } },
} satisfies Prisma.MeetingProposalSelect;

export type ApproveItemResult =
  | { id: string; status: 'APPROVED'; taskId: string }
  | { id: string; error: 'NOT_FOUND' | 'ALREADY_DECIDED' | 'VERSION_CONFLICT' | 'TASK_CREATE_FAILED'; message: string };

const ERROR_TEXT = {
  NOT_FOUND: 'Поручение не найдено',
  ALREADY_DECIDED: 'Поручение уже утверждено или отклонено',
  VERSION_CONFLICT: 'Поручение изменилось — обновите страницу',
} as const;

function parseDue(value: string | null | undefined): Date | null | undefined {
  if (value === undefined || value === null) return value;
  // Только день из поля даты — конец рабочего дня по местному времени, как
  // у сроков, которые извлекла модель.
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return parseLocalDue(value);
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function proposalEdits(item: ApproveProposalItemDto): Prisma.MeetingProposalUncheckedUpdateManyInput {
  const edits: Prisma.MeetingProposalUncheckedUpdateManyInput = {};
  if (item.title !== undefined) edits.title = item.title.trim();
  if (item.assigneeId !== undefined) edits.assigneeId = item.assigneeId;
  if (item.dueDate !== undefined) edits.dueDate = parseDue(item.dueDate);
  if (item.priority !== undefined) edits.priority = item.priority;
  return edits;
}

@Injectable()
export class MeetingProposalsService {
  private readonly logger = new Logger(MeetingProposalsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tasks: TasksService,
    private readonly audit: AuditService,
    private readonly analysis: MeetingAnalysisService,
  ) {}

  // Предложения последнего УСПЕШНОГО разбора: пока идёт «Разобрать заново»
  // или он упал, на странице остаётся прежний список.
  async list(meetingId: string) {
    const meeting = await this.prisma.meeting.findUnique({ where: { id: meetingId }, select: { id: true } });
    if (!meeting) throw new NotFoundException('Встреча не найдена');

    const [run, lastDone, segmentCount] = await Promise.all([
      this.analysis.latest(meetingId),
      this.prisma.meetingAnalysisRun.findFirst({
        where: { meetingId, status: MeetingAnalysisStatus.DONE },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      }),
      this.prisma.meetingSegment.count({ where: { meetingId } }),
    ]);
    const proposals = lastDone
      ? await this.prisma.meetingProposal.findMany({ where: { runId: lastDone.id }, orderBy: { order: 'asc' }, select: PROPOSAL_SELECT })
      : [];
    // hasTranscript — для предупреждения на кнопке до запуска.
    return { run, hasTranscript: segmentCount > 0, proposals };
  }

  async approve(meetingId: string, items: ApproveProposalItemDto[], actor: AuthenticatedUser): Promise<{ results: ApproveItemResult[] }> {
    const results: ApproveItemResult[] = [];
    // По одному, без общей транзакции — как createTasksFromMeeting: сбой
    // одного пункта не откатывает уже созданные задачи остальных.
    for (const item of items) results.push(await this.approveOne(meetingId, item, actor));

    const approved = results.filter((r) => 'taskId' in r).length;
    if (approved > 0) {
      await this.audit.log(actor.id, 'MEETING_PROPOSALS_APPROVED', 'Meeting', meetingId, { count: approved });
    }
    return { results };
  }

  private async approveOne(meetingId: string, item: ApproveProposalItemDto, actor: AuthenticatedUser): Promise<ApproveItemResult> {
    // Захват PROPOSED → APPROVED с проверкой версии: второе нажатие (другая
    // вкладка, ассистент) не создаст вторую задачу.
    const claimed = await this.prisma.meetingProposal.updateMany({
      where: { id: item.id, meetingId, status: MeetingProposalStatus.PROPOSED, version: item.version },
      data: { ...proposalEdits(item), status: MeetingProposalStatus.APPROVED, version: { increment: 1 }, decidedById: actor.id, decidedAt: new Date() },
    });
    if (claimed.count === 0) {
      const current = await this.prisma.meetingProposal.findFirst({ where: { id: item.id, meetingId }, select: { status: true } });
      const error = !current ? 'NOT_FOUND' : current.status !== MeetingProposalStatus.PROPOSED ? 'ALREADY_DECIDED' : 'VERSION_CONFLICT';
      return { id: item.id, error, message: ERROR_TEXT[error] };
    }

    const p = await this.prisma.meetingProposal.findUniqueOrThrow({ where: { id: item.id } });
    try {
      const task = await this.tasks.create(
        {
          title: p.title,
          description: p.description ?? undefined,
          assigneeId: p.assigneeId,
          priority: p.priority ?? undefined,
          dueDate: p.dueDate ? p.dueDate.toISOString() : null,
          sourceMeetingId: meetingId,
          sourceSegmentId: p.sourceSegmentId ?? undefined,
          sourceTimestamp: p.sourceTimestamp ?? undefined,
          sourceContext: p.sourceContext,
          aiConfidence: p.confidence,
        },
        actor,
      );
      await this.prisma.meetingProposal.update({ where: { id: p.id }, data: { taskId: task.id } });
      return { id: p.id, status: 'APPROVED', taskId: task.id };
    } catch (err) {
      // Задача не создалась (исполнитель уволен, проверка прав) — поручение
      // снова ждёт решения, правки руководителя сохраняются.
      const message = err instanceof Error ? err.message : 'Не удалось создать задачу';
      this.logger.warn(`meeting proposal ${p.id}: задача не создана: ${message}`);
      await this.prisma.meetingProposal.update({
        where: { id: p.id },
        data: { status: MeetingProposalStatus.PROPOSED, decidedById: null, decidedAt: null },
      });
      return { id: p.id, error: 'TASK_CREATE_FAILED', message };
    }
  }

  async reject(meetingId: string, ids: string[], actor: AuthenticatedUser): Promise<{ rejected: number }> {
    const { count } = await this.prisma.meetingProposal.updateMany({
      where: { id: { in: ids }, meetingId, status: MeetingProposalStatus.PROPOSED },
      data: { status: MeetingProposalStatus.REJECTED, version: { increment: 1 }, decidedById: actor.id, decidedAt: new Date() },
    });
    if (count > 0) await this.audit.log(actor.id, 'MEETING_PROPOSALS_REJECTED', 'Meeting', meetingId, { count });
    return { rejected: count };
  }
}
