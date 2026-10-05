'use client';

import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import type { ReceptionListResponse, ReceptionRequestItem, ReceptionRequestStatus } from '@ai-task-system/shared-types';
import { api, ApiError } from '@/lib/api';
import { haptic } from '@/lib/telegram';
import { ReceptionFormOverlay } from './reception-form-overlay';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import type { BadgeTone } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { SegmentedControl } from '@/components/ui/segmented-control';

// ТЗ «Приёмная руководителя» v1.0 (02.10.2026), раздел 8 — экран сотрудника
// в Mini App: подать/список/изменить/отозвать СВОИ обращения. Очередь
// руководителя (раздел 9 ТЗ) — только Web App, спека её для Mini App не
// описывает.
const STATUS_LABELS: Record<ReceptionRequestStatus, string> = {
  WAITING: 'Ожидает',
  CALLED: 'Вызван',
  COMPLETED: 'Обсуждено',
  REJECTED: 'Отклонено',
  WITHDRAWN: 'Отозвано',
};
const STATUS_BADGE_TONE: Record<ReceptionRequestStatus, BadgeTone> = {
  WAITING: 'neutral',
  CALLED: 'warn',
  COMPLETED: 'ok',
  REJECTED: 'danger',
  WITHDRAWN: 'neutral',
};

function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
}

export function ReceptionScreen({ active = true }: { active?: boolean }) {
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

  // active — тот же приём, что TasksScreen: экран смонтирован всегда
  // (SwipeShell), данные грузим при каждом возвращении на вкладку.
  useEffect(() => {
    if (active) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load пересоздаётся каждый рендер, перезапуск только по active/scope
  }, [active, scope]);

  async function withdraw(item: ReceptionRequestItem) {
    if (!window.confirm('Убрать вопрос из очереди?')) return;
    try {
      await api.post(`/reception/requests/${item.id}/withdraw`, { version: item.version }, { 'Idempotency-Key': crypto.randomUUID() });
      haptic('medium');
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось отозвать обращение');
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '10px 0 4px' }}>
        <h1>Приёмная</h1>
        <button
          onClick={() => setFormOpen('create')}
          aria-label="Подать вопрос"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 34,
            height: 34,
            borderRadius: '50%',
            background: 'var(--accent)',
            color: 'var(--accent-contrast)',
          }}
        >
          <Plus size={18} strokeWidth={2.5} />
        </button>
      </div>

      <div style={{ margin: '8px 0 12px' }}>
        <SegmentedControl
          options={[
            { value: 'active', label: 'Активные' },
            { value: 'history', label: 'История' },
          ]}
          value={scope}
          onChange={(v) => setScope(v as 'active' | 'history')}
        />
      </div>

      {error && <Alert tone="danger">{error}</Alert>}
      {!data && !error && <p className="ds-field-hint">Загрузка…</p>}
      {data && data.items.length === 0 && (
        <EmptyState title={scope === 'active' ? 'Активных обращений нет' : 'История пуста'} />
      )}

      {data?.items.map((item) => (
        <div key={item.id} className="task-card" style={{ display: 'block' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span className="task-card-title">{item.title}</span>
            <Badge tone={STATUS_BADGE_TONE[item.status]}>{item.status === 'CALLED' ? 'Вас вызывают' : STATUS_LABELS[item.status]}</Badge>
          </div>
          <div className="ds-field-hint" style={{ marginTop: 4 }}>
            подано {formatDate(item.createdAt)}
            {item.desiredBy && <> · нужен ответ до {formatDate(item.desiredBy)}</>}
          </div>
          {item.status === 'REJECTED' && item.rejectionReason && <div className="ds-field-hint">Причина: {item.rejectionReason}</div>}
          {item.status === 'COMPLETED' && item.resolution && <div className="ds-field-hint">Результат: {item.resolution}</div>}
          {item.status === 'WAITING' && (
            <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
              <Button variant="secondary" size="sm" onClick={() => setFormOpen(item)}>
                Изменить
              </Button>
              <Button variant="secondary" size="sm" onClick={() => withdraw(item)}>
                Отозвать
              </Button>
            </div>
          )}
        </div>
      ))}

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
