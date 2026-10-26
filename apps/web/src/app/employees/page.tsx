'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { UserPlus } from 'lucide-react';
import type { EmployeeProfile, RegistrationWindowStatus } from '@ai-task-system/shared-types';
import { MANAGER_ROLES, ROLE_LABELS } from '@ai-task-system/shared-types';
import { api, ApiError } from '@/lib/api';
import { Protected } from '@/components/protected';
import { Avatar } from '@/components/avatar';
import { PageHeader } from '@/components/ui/card';
import { ConnectionBar } from '@/components/ui/connection-bar';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { Select } from '@/components/ui/field';

// Переключатель временного окна самостоятельной регистрации (владелец
// 02.10.2026) — человек сам заводит логин/пароль на /register, пока окно
// открыто; по умолчанию закрыто, руководитель открывает точечно, когда
// нужно принять новых людей, и закрывает обратно.
function RegistrationWindowToggle() {
  const [status, setStatus] = useState<RegistrationWindowStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Срок окна (владелец 20.10.2026) — регистрация закрывается сама; '' — без срока.
  const [days, setDays] = useState('10');

  useEffect(() => {
    api.get<RegistrationWindowStatus>('/auth/registration-window').then(setStatus).catch(() => {});
  }, []);

  async function toggle() {
    if (!status) return;
    setBusy(true);
    setError(null);
    try {
      const next = await api.patch<RegistrationWindowStatus>('/auth/registration-window', status.isOpen ? { isOpen: false } : { isOpen: true, ...(days ? { days: Number(days) } : {}) });
      setStatus(next);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось изменить окно регистрации');
    } finally {
      setBusy(false);
    }
  }

  if (!status) return null;

  return (
    <ConnectionBar
      on={status.isOpen}
      title={
        status.isOpen
          ? `Самостоятельная регистрация открыта${status.closesAt ? ` до ${new Date(status.closesAt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}` : ''}`
          : 'Самостоятельная регистрация закрыта'
      }
      meta={status.isOpen ? 'Любой человек может завести логин и пароль на /register' : 'Новые учётки заводит только руководитель'}
      actions={
        <>
          {!status.isOpen && (
            <Select
              value={days}
              onChange={(e) => setDays(e.target.value)}
              aria-label="Срок регистрации"
              options={[
                { value: '3', label: 'на 3 дня' },
                { value: '7', label: 'на 7 дней' },
                { value: '10', label: 'на 10 дней' },
                { value: '30', label: 'на 30 дней' },
                { value: '', label: 'без срока' },
              ]}
            />
          )}
          <Button variant="secondary" size="sm" onClick={toggle} disabled={busy}>
            {status.isOpen ? 'Закрыть' : 'Открыть'}
          </Button>
        </>
      }
    >
      {error && <Alert tone="danger">{error}</Alert>}
    </ConnectionBar>
  );
}

function EmployeesList() {
  const [employees, setEmployees] = useState<EmployeeProfile[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<EmployeeProfile[]>('/employees')
      .then(setEmployees)
      .catch(() => setError('Не удалось загрузить список сотрудников'));
  }, []);

  if (error) return <Alert tone="danger">{error}</Alert>;
  if (!employees) return <p className="ds-field-hint">Загрузка…</p>;
  if (employees.length === 0) {
    return <EmptyState icon={UserPlus} title="Сотрудников пока нет" description="Добавьте первого сотрудника, чтобы начать раздавать задачи." />;
  }

  return (
    <div className="ds-table-wrap">
      <table className="ds-table">
        <thead>
          <tr>
            <th>Сотрудник</th>
            <th>Должность</th>
            <th>Email</th>
            <th>Роль</th>
            <th>Статус</th>
          </tr>
        </thead>
        <tbody>
          {employees.map((e) => (
            <tr key={e.id}>
              <td>
                <Link href={`/employees/${e.id}`} className="ds-table-person">
                  <Avatar id={e.id} name={e.fullName} size={28} />
                  {e.fullName}
                </Link>
              </td>
              <td>{e.position?.title ?? '—'}</td>
              <td>{e.email}</td>
              <td>{ROLE_LABELS[e.role]}</td>
              <td>
                <Badge tone={e.status === 'ACTIVE' ? 'ok' : 'neutral'}>{e.status === 'ACTIVE' ? 'Активен' : 'Неактивен'}</Badge>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function EmployeesPage() {
  return (
    <Protected requireRole={MANAGER_ROLES}>
      <PageHeader
        title="Сотрудники"
        actions={
          <Link href="/employees/new" className="ds-btn ds-btn-primary">
            <UserPlus size={18} strokeWidth={1.75} />
            Добавить сотрудника
          </Link>
        }
      />
      <RegistrationWindowToggle />
      <EmployeesList />
    </Protected>
  );
}
