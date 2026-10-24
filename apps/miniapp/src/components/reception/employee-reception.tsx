'use client';

import { useEffect, useState } from 'react';
import { ArrowLeft, Plus } from 'lucide-react';
import type { ReceptionListResponse, ReceptionRequestItem, ReceptionRequestStatus } from '@ai-task-system/shared-types';
import { api, ApiError } from '@/lib/api';
import { companyDate, companyTime } from '@/lib/company-time';
import { RECEPTION_STATUS_LABELS } from '@/lib/labels';
import { notificationHaptic } from '@/lib/telegram';
import { Alert, Button, EmptyState, Pill, ScreenHeader, cx, type PillTone } from '@/components/ui';
import { ReceptionFormOverlay } from '../reception-form-overlay';
import { ReceptionAttachmentList } from '../reception-attachments';

// ТЗ «Приёмная руководителя» v1.0 (02.10.2026), раздел 8 — свои вопросы:
// подать/список/изменить/отозвать. Логика прежняя, вид — компоненты
// редизайна (M4, MINIAPP_REDESIGN.md §4.5). Руководителю этот экран
// открывается из очереди («Мои вопросы», onBack — назад к очереди).

const STATUS_TONE: Record<ReceptionRequestStatus, PillTone> = {
  WAITING: 'neutral',
  CALLED: 'orange',
  COMPLETED: 'teal',
  ANSWERED: 'teal',
  DELEGATED: 'blue',
  REJECTED: 'neutral',
  WITHDRAWN: 'neutral',
};

function when(value: string): string {
  return `${companyDate(value)}, ${companyTime(value)}`;
}

export function EmployeeReception({ active, onBack }: { active: boolean; onBack?: () => void }) {
  const [scope, setScope] = useState<'active' | 'history'>('active');
  const [data, setData] = useState<ReceptionListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState<'create' | ReceptionRequestItem | null>(null);

  function load() {
    api
      .get<ReceptionListResponse>(`/reception/requests/mine?scope=${scope}&limit=50`)
      .then((r) => {
        setData(r);
        setError(null);
      })
      .catch(() => setError('Не удалось загрузить обращения'));
  }

  // active — тот же приём, что TasksScreen: экран остаётся смонтированным
  // (AppShell), данные грузим при каждом возвращении на вкладку.
  useEffect(() => {
    if (active) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load пересоздаётся каждый рендер, перезапуск только по active/scope
  }, [active, scope]);

  async function withdraw(item: ReceptionRequestItem) {
    if (!window.confirm('Убрать вопрос из очереди?')) return;
    try {
      await api.post(`/reception/requests/${item.id}/withdraw`, { version: item.version }, { 'Idempotency-Key': crypto.randomUUID() });
      notificationHaptic('success');
      load();
    } catch (err) {
      notificationHaptic('error');
      setError(err instanceof ApiError ? err.message : 'Не удалось отозвать обращение');
    }
  }

  return (
    <div>
      {onBack && (
        <button type="button" className="rcp-back" onClick={onBack}>
          <ArrowLeft size={18} strokeWidth={2} />
          Очередь
        </button>
      )}
      <ScreenHeader
        kicker="Мои вопросы"
        title="Приёмная"
        action={
          <button type="button" className="screen-header-add" onClick={() => setFormOpen('create')} aria-label="Подать вопрос">
            <Plus size={22} strokeWidth={2.25} />
          </button>
        }
      />

      <div className="filter-chips" role="tablist" aria-label="Мои вопросы">
        {(['active', 'history'] as const).map((s) => (
          <button
            key={s}
            type="button"
            role="tab"
            aria-selected={scope === s}
            className={cx('filter-chip', scope === s && 'is-active')}
            onClick={() => setScope(s)}
          >
            {s === 'active' ? 'Активные' : 'История'}
          </button>
        ))}
      </div>

      {error && <Alert tone="danger">{error}</Alert>}
      {!data && !error && <p className="ds-field-hint">Загрузка…</p>}
      {data && data.items.length === 0 && <EmptyState title={scope === 'active' ? 'Активных обращений нет' : 'История пуста'} />}

      <div className="task-list">
        {data?.items.map((item) => (
          <article key={item.id} className="rcp-mine">
            <div className="rcp-mine-head">
              <strong>{item.title}</strong>
              <Pill tone={STATUS_TONE[item.status]}>{item.status === 'CALLED' ? 'Вас вызывают' : RECEPTION_STATUS_LABELS[item.status]}</Pill>
            </div>
            <span className="due">
              подано {when(item.createdAt)}
              {item.desiredBy && ` · ответ до ${when(item.desiredBy)}`}
            </span>
            {item.attachments.length > 0 && <ReceptionAttachmentList requestId={item.id} attachments={item.attachments} />}
            {item.status === 'REJECTED' && item.rejectionReason && <p className="rcp-mine-note">Причина: {item.rejectionReason}</p>}
            {item.status === 'COMPLETED' && item.resolution && <p className="rcp-mine-note">Итог: {item.resolution}</p>}
            {item.status === 'ANSWERED' && item.resolution && <p className="rcp-mine-answer">{item.resolution}</p>}
            {item.status === 'DELEGATED' && item.resolution && <p className="rcp-mine-note">Комментарий: {item.resolution}</p>}
            {item.task && (
              <p className="rcp-mine-note">
                Задача: {item.task.title}
                {item.task.dueDate && ` · до ${companyDate(item.task.dueDate)}`}
              </p>
            )}
            {item.status === 'WAITING' && (
              <div className="rcp-mine-actions">
                <Button variant="secondary" size="sm" onClick={() => setFormOpen(item)}>
                  Изменить
                </Button>
                <Button variant="ghost" size="sm" onClick={() => void withdraw(item)}>
                  Отозвать
                </Button>
              </div>
            )}
          </article>
        ))}
      </div>

      {formOpen && (
        <ReceptionFormOverlay
          editing={formOpen === 'create' ? null : formOpen}
          onClose={() => setFormOpen(null)}
          onSaved={() => {
            setScope('active');
            load();
          }}
        />
      )}
    </div>
  );
}
