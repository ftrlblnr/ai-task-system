import { MessagePartType, type MailActionItemStatus, type MailDraftState, type MessagePart, type PrismaClient } from '@prisma/client';
import type { MailDraftCardData, MailPlanCardData } from './dto/message-part-data.dto';

// Почта, этап 3 — в истории для модели у карточки плана/письма должен быть
// НАСТОЯЩИЙ статус (подтверждено? выполнено? ошибка?), а не застывший
// «ждёт пользователя» (инцидент 23.10.2026: «тебе удалось перенести?» —
// модель не знала, что перенос упал, и начала оправдываться).

export interface MailCardState {
  plans: Map<string, string>;
  drafts: Map<string, string>;
}

type PlanItemState = { planId: string; type: string; status: MailActionItemStatus; selected: boolean; errorCode: string | null };

const IN_PROGRESS: ReadonlySet<MailActionItemStatus> = new Set(['APPROVED', 'QUEUED', 'RUNNING']);

export function describePlanState(items: PlanItemState[]): string {
  if (items.length === 0) return 'unknown';
  if (items.every((i) => !i.selected && i.status === 'NEEDS_REVIEW')) return 'declined_by_user';
  if (items.some((i) => IN_PROGRESS.has(i.status))) return 'executing';
  if (items.some((i) => i.selected && i.status === 'NEEDS_REVIEW')) return 'awaiting_user_confirmation';
  const parts = items
    .filter((i) => i.selected || i.status !== 'NEEDS_REVIEW')
    .map((i) => `${i.type}:${i.status === 'SUCCEEDED' ? 'done' : i.status.toLowerCase()}${i.errorCode ? `(${i.errorCode})` : ''}`);
  return `finished ${parts.join(',')}`;
}

const DRAFT_STATE: Record<MailDraftState, string> = {
  DRAFT: 'awaiting_user_send',
  SENDING: 'sending',
  SENT: 'sent',
  DISCARDED: 'deleted_by_user',
};

export async function loadMailCardState(prisma: Pick<PrismaClient, 'mailActionItem' | 'mailDraft'>, parts: MessagePart[]): Promise<MailCardState> {
  const planIds = parts.filter((p) => p.type === MessagePartType.MAIL_PLAN_CARD).map((p) => (p.data as unknown as MailPlanCardData).planId);
  const draftIds = parts.filter((p) => p.type === MessagePartType.MAIL_DRAFT_CARD).map((p) => (p.data as unknown as MailDraftCardData).draftId);
  const state: MailCardState = { plans: new Map(), drafts: new Map() };

  if (planIds.length > 0) {
    const rows = await prisma.mailActionItem.findMany({
      where: { planId: { in: planIds } },
      orderBy: { createdAt: 'asc' },
      select: { planId: true, type: true, status: true, selected: true, attempts: { orderBy: { attemptNumber: 'desc' }, take: 1, select: { errorCode: true } } },
    });
    for (const planId of planIds) {
      const items = rows.filter((r) => r.planId === planId).map((r) => ({ ...r, errorCode: r.attempts[0]?.errorCode ?? null }));
      state.plans.set(planId, describePlanState(items));
    }
  }
  if (draftIds.length > 0) {
    const rows = await prisma.mailDraft.findMany({ where: { id: { in: draftIds } }, select: { id: true, state: true } });
    for (const id of draftIds) {
      const row = rows.find((r) => r.id === id);
      state.drafts.set(id, row ? DRAFT_STATE[row.state] : 'deleted_by_user');
    }
  }
  return state;
}
