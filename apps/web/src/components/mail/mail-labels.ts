import type { EmailReplyStatus } from '@ai-task-system/shared-types';
import type { BadgeTone } from '@/components/ui/badge';

// Подписи и форматирование почты — общие для вкладок страницы «Почта».
// Вынесено из app/mail/page.tsx (редизайн web W0).

export const REPLY_STATUS_LABELS: Record<EmailReplyStatus, string> = {
  AWAITING_MY_REPLY: 'Ждёт вашего ответа',
  REPLIED: 'Вы ответили',
  NO_REPLY_REQUIRED: 'Ответ не нужен',
  AWAITING_THEIR_REPLY: 'Ждём ответ',
  UNKNOWN: '',
};

// Владелец 30.09.2026: цветовой индикатор в подписях писем — Важно/Критично
// красным-оранжевым, Вы ответили зелёным, Ответ не нужен/Не важно серым.
// Дизайн-система «Адъютант» (04.10.2026, шаг 4) — тон Badge вместо
// собственных badge-danger/badge-warn/badge-ok классов.
export const REPLY_STATUS_BADGE_TONE: Record<EmailReplyStatus, BadgeTone> = {
  AWAITING_MY_REPLY: 'warn',
  REPLIED: 'ok',
  NO_REPLY_REQUIRED: 'neutral',
  AWAITING_THEIR_REPLY: 'neutral',
  UNKNOWN: 'neutral',
};

// NORMAL/LOW теперь тоже подписаны (владелец 30.09.2026: индикатор важности
// должен быть виден у каждого проанализированного письма, не только у
// критичных/важных).
export const IMPORTANCE_LABELS: Record<string, string> = { CRITICAL: 'Критично', IMPORTANT: 'Важно', NORMAL: 'Обычно', LOW: 'Не важно' };
export const IMPORTANCE_BADGE_TONE: Record<string, BadgeTone> = {
  CRITICAL: 'danger',
  IMPORTANT: 'warn',
  NORMAL: 'neutral',
  LOW: 'neutral',
};


export function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
}

export function senderLabel(m: { fromName: string | null; fromAddress: string }): string {
  return m.fromName?.trim() || m.fromAddress;
}
