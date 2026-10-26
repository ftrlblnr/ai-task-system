'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Target } from 'lucide-react';
import type { DashboardMailSection, DashboardReceptionSection, DashboardTasksSection } from '@ai-task-system/shared-types';
import { api, ApiError } from '@/lib/api';
import { Alert, Button, Panel, Skeleton, cx } from '@/components/ui';
import type { SectionState } from './use-dashboard-overview';
import { span } from './format';

// «Фокус дня» (редизайн web W5, docs/WEB_REDESIGN.md §4.3): четыре плитки
// со ссылками на разделы и «Требует вас» — человек в приёмной, письма без
// ответа, просроченные задачи; у каждой строки одно действие.

const ATTENTION_LIMIT = 6;
const MAIL_IN_ATTENTION = 2;

type Kind = 'reception' | 'mail' | 'overdue';

const KIND_LABEL: Record<Kind, string> = { reception: 'Приёмная', mail: 'Письмо', overdue: 'Просрочка' };

interface AttentionRow {
  key: string;
  kind: Kind;
  title: string;
  meta: string;
  action: { label: string; href?: string; onClick?: () => void; busy?: boolean; disabled?: boolean; hint?: string };
}

interface Props {
  tasks: SectionState<DashboardTasksSection>;
  reception: SectionState<DashboardReceptionSection>;
  mail: SectionState<DashboardMailSection>;
  loading: boolean;
  now: number;
  onChanged: () => void;
}

function Tile({ value, label, href, hot, errored }: { value: number | null; label: string; href: string; hot?: boolean; errored: boolean }) {
  return (
    <Link href={href} className={cx('pult-tile', hot && (value ?? 0) > 0 && 'is-hot')}>
      {value === null ? errored ? <span className="pult-tile-value">—</span> : <Skeleton width={36} height={28} /> : <span className="pult-tile-value ds-num">{value}</span>}
      <span className="pult-tile-label">{label}</span>
    </Link>
  );
}

export function FocusSection({ tasks, reception, mail, loading, now, onChanged }: Props) {
  const [callingId, setCallingId] = useState<string | null>(null);
  const [callError, setCallError] = useState<string | null>(null);
  const counts = tasks.data?.counts;

  async function call(id: string, version: number) {
    setCallingId(id);
    setCallError(null);
    try {
      await api.post(`/reception/requests/${id}/call`, { version }, { 'Idempotency-Key': crypto.randomUUID() });
    } catch (err) {
      const message = err instanceof ApiError ? err.message.replace(/^[A-Z_]+: /, '') : '';
      setCallError(err instanceof ApiError && err.status === 409 && !err.message.startsWith('RECEPTION_BUSY') ? 'Очередь изменилась — обновите пульт' : message || 'Не удалось позвать');
    } finally {
      setCallingId(null);
      onChanged();
    }
  }

  const rows: AttentionRow[] = [];
  const first = reception.data?.items[0];
  if (first) {
    const busy = reception.data?.current != null;
    rows.push({
      key: `r:${first.id}`,
      kind: 'reception',
      title: first.title,
      meta: `${first.author.fullName} · ждёт ${span(new Date(first.createdAt).getTime(), now)}`,
      action: {
        label: 'Позвать',
        onClick: () => void call(first.id, first.version),
        busy: callingId === first.id,
        // Пока кто-то вызван, сервер второго не позовёт (RECEPTION_BUSY).
        disabled: busy,
        hint: busy ? 'Сначала завершите текущий приём' : undefined,
      },
    });
  }
  for (const m of (mail.data?.top ?? []).filter((x) => x.tag === 'REPLY').slice(0, MAIL_IN_ATTENTION)) {
    rows.push({
      key: `m:${m.id}`,
      kind: 'mail',
      title: m.subject || '(без темы)',
      meta: m.receivedAt ? `${m.from} · без ответа ${span(new Date(m.receivedAt).getTime(), now)}` : m.from,
      action: { label: 'Ответить', href: `/mail?message=${m.id}` },
    });
  }
  for (const t of (tasks.data?.items ?? []).filter((x) => x.isOverdue)) {
    rows.push({
      key: `t:${t.id}`,
      kind: 'overdue',
      title: t.title,
      meta: [t.assignee?.fullName, t.dueDate ? `просрочена на ${span(new Date(t.dueDate).getTime(), now)}` : 'просрочена'].filter(Boolean).join(' · '),
      action: { label: 'Открыть', href: `/tasks?task=${t.id}` },
    });
  }

  const ready = Boolean(tasks.data || reception.data || mail.data);

  return (
    <Panel icon={Target} title="Фокус дня" className="pult-focus">
      <div className="pult-tiles">
        <Tile value={counts?.active ?? null} label="активных" href="/tasks?filter=active" errored={Boolean(tasks.error)} />
        <Tile value={counts?.overdue ?? null} label="просрочено" href="/tasks?filter=overdue" hot errored={Boolean(tasks.error)} />
        <Tile value={counts?.inReview ?? null} label="на проверке" href="/tasks?filter=review" errored={Boolean(tasks.error)} />
        <Tile value={reception.data?.waitingCount ?? null} label="в приёмной" href="/reception" errored={Boolean(reception.error)} />
      </div>

      <span className="section-kicker">Требует вас</span>
      {callError && <Alert tone="danger">{callError}</Alert>}
      {!ready ? (
        loading ? (
          <Skeleton height={56} />
        ) : (
          <p className="console-empty">Данные недоступны</p>
        )
      ) : rows.length === 0 ? (
        <p className="console-empty">Ничего срочного</p>
      ) : (
        <ul className="pult-attention">
          {rows.slice(0, ATTENTION_LIMIT).map((r) => (
            <li key={r.key} className="pult-attention-row">
              <span className={`pult-kind is-${r.kind}`}>{KIND_LABEL[r.kind]}</span>
              <span className="pult-attention-text">
                <span className="pult-attention-title">{r.title}</span>
                <span className="pult-attention-meta">{r.meta}</span>
              </span>
              {r.action.href ? (
                <Link href={r.action.href} className="ds-btn ds-btn-secondary ds-btn-sm">
                  {r.action.label}
                </Link>
              ) : (
                <Button variant="secondary" size="sm" loading={r.action.busy} disabled={r.action.disabled} title={r.action.hint} onClick={r.action.onClick}>
                  {r.action.label}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
