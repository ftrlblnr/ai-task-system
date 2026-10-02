'use client';

import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import type { ReceptionListResponse, ReceptionRequestItem, ReceptionRequestStatus } from '@ai-task-system/shared-types';
import { api, ApiError } from '@/lib/api';
import { haptic } from '@/lib/telegram';
import { ReceptionFormOverlay } from './reception-form-overlay';

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
const STATUS_BADGE_CLASS: Record<ReceptionRequestStatus, string> = {
  WAITING: 'badge badge-muted',
  CALLED: 'badge badge-warn',
  COMPLETED: 'badge badge-ok',
  REJECTED: 'badge badge-danger',
  WITHDRAWN: 'badge badge-muted',
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

      <div style={{ display: 'flex', gap: 8, margin: '8px 0 12px' }}>
        <button className={scope === 'active' ? 'btn btn-small' : 'btn-secondary btn-small'} onClick={() => setScope('active')}>
          Активные
        </button>
        <button className={scope === 'history' ? 'btn btn-small' : 'btn-secondary btn-small'} onClick={() => setScope('history')}>
          История
        </button>
      </div>

      {error && <p className="error">{error}</p>}
      {!data && !error && <p className="hint">Загрузка…</p>}
      {data && data.items.length === 0 && (
        <div className="empty-state">
          <strong>{scope === 'active' ? 'Активных обращений нет' : 'История пуста'}</strong>
        </div>
      )}

      {data?.items.map((item) => (
        <div key={item.id} className="task-card" style={{ display: 'block' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span className="task-card-title">{item.title}</span>
            <span className={STATUS_BADGE_CLASS[item.status]}>{item.status === 'CALLED' ? 'Вас вызывают' : STATUS_LABELS[item.status]}</span>
          </div>
          <div className="hint" style={{ marginTop: 4 }}>
            подано {formatDate(item.createdAt)}
            {item.desiredBy && <> · нужен ответ до {formatDate(item.desiredBy)}</>}
          </div>
          {item.status === 'REJECTED' && item.rejectionReason && <div className="hint">Причина: {item.rejectionReason}</div>}
          {item.status === 'COMPLETED' && item.resolution && <div className="hint">Результат: {item.resolution}</div>}
          {item.status === 'WAITING' && (
            <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
              <button className="btn-secondary btn-small" onClick={() => setFormOpen(item)}>
                Изменить
              </button>
              <button className="btn-secondary btn-small" onClick={() => withdraw(item)}>
                Отозвать
              </button>
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
