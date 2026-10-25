import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, Recommendation, RecommendationBatchStatus, RecommendationBatchTrigger, RecommendationStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { MemoryService } from '../memory/memory.service';
import { RoutinesService } from '../routines/routines.service';
import { SkillsService } from '../skills/skills.service';
import { TasksService } from '../tasks/tasks.service';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import type { RecoPayload } from './recommendation-prompt';

// Рекомендации (ARMS, фаза 5): список, корзина, «Применить выбранное».
// Применение — через те же сервисы и с теми же правами, что и ручные
// действия на страницах навыков/регламентов/памяти; каждое — в аудит.

export interface RecoResult {
  kind: 'routine' | 'skill' | 'skillRevision' | 'memory' | 'task';
  id: string;
  label: string;
}

const HISTORY_DAYS = 30;
const APPLY_MAX = 20;

function view(r: Recommendation) {
  return {
    id: r.id,
    area: r.area,
    action: r.action,
    title: r.title,
    benefit: r.benefit,
    plan: r.plan,
    effort: r.effort,
    priority: r.priority,
    tokenSaving: r.tokenSaving,
    devTask: r.action === 'DEV_TASK' ? (r.payload as unknown as RecoPayload).text : null,
    status: r.status,
    result: (r.result as unknown as RecoResult | null) ?? null,
    error: r.error,
    createdAt: r.createdAt.toISOString(),
    decidedAt: r.decidedAt?.toISOString() ?? null,
  };
}

function batchView(b: { id: string; status: RecommendationBatchStatus; trigger: RecommendationBatchTrigger; createdAt: Date; finishedAt: Date | null; costUsd: number | null }) {
  return { id: b.id, status: b.status, trigger: b.trigger, createdAt: b.createdAt.toISOString(), finishedAt: b.finishedAt?.toISOString() ?? null, costUsd: b.costUsd };
}

@Injectable()
export class RecommendationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly memory: MemoryService,
    private readonly routines: RoutinesService,
    private readonly skills: SkillsService,
    private readonly tasks: TasksService,
  ) {}

  async overview(userId: string) {
    const since = new Date(Date.now() - HISTORY_DAYS * 86400_000);
    const [items, batch] = await Promise.all([
      this.prisma.recommendation.findMany({
        where: {
          ownerId: userId,
          OR: [{ status: { in: [RecommendationStatus.NEW, RecommendationStatus.IN_CART] } }, { decidedAt: { gt: since } }],
        },
        orderBy: [{ priority: 'asc' }, { createdAt: 'desc' }],
      }),
      this.prisma.recommendationBatch.findFirst({ where: { ownerId: userId }, orderBy: { createdAt: 'desc' } }),
    ]);
    return { items: items.map(view), batch: batch ? batchView(batch) : null };
  }

  // «Собрать сейчас» — тот же фоновый прогон, что и в пятницу.
  async requestNow(userId: string) {
    const busy = await this.prisma.recommendationBatch.findFirst({ where: { ownerId: userId, status: RecommendationBatchStatus.GENERATING }, select: { id: true } });
    if (busy) throw new ConflictException('Рекомендации уже собираются');
    const batch = await this.prisma.recommendationBatch.create({ data: { ownerId: userId, trigger: RecommendationBatchTrigger.BUTTON } });
    return batchView(batch);
  }

  private async findOwn(userId: string, id: string): Promise<Recommendation> {
    const reco = await this.prisma.recommendation.findFirst({ where: { id, ownerId: userId } });
    if (!reco) throw new NotFoundException('Рекомендация не найдена');
    return reco;
  }

  // Корзина и «Отклонить». Применённую не трогаем; отклонённую можно вернуть.
  async setStatus(userId: string, id: string, status: 'NEW' | 'IN_CART' | 'DISMISSED') {
    const reco = await this.findOwn(userId, id);
    if (reco.status === RecommendationStatus.APPLIED) throw new BadRequestException('Рекомендация уже применена');
    const updated = await this.prisma.recommendation.update({
      where: { id },
      data: { status, decidedAt: status === 'DISMISSED' ? new Date() : null, error: null },
    });
    if (status === 'DISMISSED') await this.audit.log(userId, 'RECOMMENDATION_DISMISS', 'Recommendation', id, { title: reco.title });
    return view(updated);
  }

  // «Применить выбранное»: по одной, ошибка одной не останавливает остальные.
  async apply(user: AuthenticatedUser, ids: string[]) {
    const unique = [...new Set(ids)].slice(0, APPLY_MAX);
    const out: ReturnType<typeof view>[] = [];
    for (const id of unique) {
      const reco = await this.findOwn(user.id, id);
      // Захват: decidedAt у открытой рекомендации — «применяется»; двойной
      // клик или вторая вкладка не создадут задачу дважды.
      const claimed = await this.prisma.recommendation.updateMany({
        where: { id, status: { in: [RecommendationStatus.NEW, RecommendationStatus.IN_CART] }, decidedAt: null },
        data: { decidedAt: new Date() },
      });
      if (claimed.count === 0) {
        out.push(view(reco));
        continue;
      }
      try {
        const result = await this.applyOne(user, reco);
        const updated = await this.prisma.recommendation.update({
          where: { id },
          data: { status: RecommendationStatus.APPLIED, result: result as unknown as Prisma.InputJsonValue, error: null, decidedAt: new Date() },
        });
        await this.audit.log(user.id, 'RECOMMENDATION_APPLY', 'Recommendation', id, { action: reco.action, title: reco.title, result: { ...result } });
        out.push(view(updated));
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Не удалось применить';
        const updated = await this.prisma.recommendation.update({ where: { id }, data: { error: message.slice(0, 300), decidedAt: null } });
        out.push(view(updated));
      }
    }
    return out;
  }

  private async applyOne(user: AuthenticatedUser, reco: Recommendation): Promise<RecoResult> {
    const p = reco.payload as unknown as RecoPayload;
    const key = `reco:${reco.id}`;
    switch (reco.action) {
      case 'CREATE_ROUTINE': {
        if (!p.routine) throw new BadRequestException('Нет параметров регламента');
        const r = p.routine;
        const routine = await this.routines.proposeDraft(
          user.id,
          { title: r.title, skillId: p.targetId, prompt: p.targetId ? null : r.prompt, days: r.days, time: r.time, mode: r.mode, channel: r.channel },
          key,
        );
        return { kind: 'routine', id: routine.id, label: `Черновик регламента «${routine.title}»` };
      }
      case 'SET_ROUTINE_CAP': {
        const routine = await this.routines.update(user.id, this.target(p), { weeklyTokenCap: p.weeklyTokenCap });
        return { kind: 'routine', id: routine.id, label: `Лимит регламента «${routine.title}»` };
      }
      case 'REVISE_SKILL': {
        if (!p.text) throw new BadRequestException('Нет новой инструкции');
        const revision = await this.skills.proposeRevision(user.id, this.target(p), p.text, reco.benefit);
        return { kind: 'skillRevision', id: revision.skillId, label: 'Предложение в навыке — посмотрите и примените' };
      }
      case 'DOWNGRADE_SKILL_MODEL': {
        if (!p.model) throw new BadRequestException('Не указана модель');
        const skill = await this.skills.update(user.id, this.target(p), { model: p.model });
        return { kind: 'skill', id: skill.id, label: `Навык /${skill.slug}` };
      }
      case 'DISABLE_SKILL': {
        const skill = await this.skills.update(user.id, this.target(p), { enabled: false });
        return { kind: 'skill', id: skill.id, label: `Навык /${skill.slug} в архиве` };
      }
      case 'ADD_MEMORY': {
        if (!p.memoryKind || !p.text) throw new BadRequestException('Нет текста для памяти');
        const { item } = await this.memory.remember(user.id, { kind: p.memoryKind, text: p.text }, key);
        return { kind: 'memory', id: item.id, label: `Память: «${item.text}»` };
      }
      case 'ARCHIVE_MEMORY': {
        const item = await this.memory.forget(user.id, this.target(p));
        return { kind: 'memory', id: item.id, label: `Убрано из памяти: «${item.text}»` };
      }
      case 'DEV_TASK': {
        const task = await this.tasks.create(
          { title: `Доработка: ${reco.title}`.slice(0, 200), description: devTaskMarkdown(reco.title, reco.benefit, reco.plan, p.text), assigneeId: user.id },
          user,
        );
        return { kind: 'task', id: task.id, label: `Задача «${task.title}»` };
      }
    }
  }

  private target(p: RecoPayload): string {
    if (!p.targetId) throw new BadRequestException('Не указана цель');
    return p.targetId;
  }
}

export function devTaskMarkdown(title: string, benefit: string, plan: string, spec: string | null): string {
  return [`## ${title}`, `**Зачем:** ${benefit}`, `**Что сделать:** ${plan}`, spec ? `\n${spec}` : ''].filter(Boolean).join('\n\n').trim();
}
