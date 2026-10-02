'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { UserPlus } from 'lucide-react';
import type { EmployeeProfile, RegistrationWindowStatus } from '@ai-task-system/shared-types';
import { api, ApiError } from '@/lib/api';
import { Protected } from '@/components/protected';
import { Avatar } from '@/components/avatar';

// Переключатель временного окна самостоятельной регистрации (владелец
// 02.10.2026) — человек сам заводит логин/пароль на /register, пока окно
// открыто; по умолчанию закрыто, руководитель открывает точечно, когда
// нужно принять новых людей, и закрывает обратно.
function RegistrationWindowToggle() {
  const [status, setStatus] = useState<RegistrationWindowStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<RegistrationWindowStatus>('/auth/registration-window').then(setStatus).catch(() => {});
  }, []);

  async function toggle() {
    if (!status) return;
    setBusy(true);
    setError(null);
    try {
      const next = await api.patch<RegistrationWindowStatus>('/auth/registration-window', { isOpen: !status.isOpen });
      setStatus(next);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось изменить окно регистрации');
    } finally {
      setBusy(false);
    }
  }

  if (!status) return null;

  return (
    <div className="card" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 16 }}>
      <div>
        <strong>Самостоятельная регистрация</strong>
        <p className="hint" style={{ margin: 0 }}>
          {status.isOpen
            ? 'Открыта — любой человек может завести логин/пароль на /register'
            : 'Закрыта — новые учётки заводит только руководитель'}
        </p>
        {error && <p className="error">{error}</p>}
      </div>
      <button className={status.isOpen ? 'btn-secondary' : 'btn'} onClick={toggle} disabled={busy}>
        {status.isOpen ? 'Закрыть' : 'Открыть'}
      </button>
    </div>
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

  if (error) return <p className="error">{error}</p>;
  if (!employees) return <p className="hint">Загрузка…</p>;
  if (employees.length === 0) {
    return (
      <div className="empty-state">
        <strong>Сотрудников пока нет</strong>
        <p className="hint">Добавьте первого сотрудника, чтобы начать раздавать задачи.</p>
      </div>
    );
  }

  return (
    <div className="table-wrap">
      <table className="table">
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
                <Link href={`/employees/${e.id}`} className="table-person">
                  <Avatar name={e.fullName} size={28} />
                  {e.fullName}
                </Link>
              </td>
              <td>{e.position?.title ?? '—'}</td>
              <td>{e.email}</td>
              <td>{e.role === 'OWNER' ? 'Руководитель' : 'Подчинённый'}</td>
              <td>
                <span className={`badge ${e.status === 'ACTIVE' ? 'status-done' : 'badge-muted'}`}>
                  {e.status === 'ACTIVE' ? 'Активен' : 'Неактивен'}
                </span>
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
    <Protected requireRole="OWNER">
      <div className="page-header">
        <h1>Сотрудники</h1>
        <Link href="/employees/new" className="btn">
          <UserPlus size={16} strokeWidth={2.25} />
          Добавить сотрудника
        </Link>
      </div>
      <RegistrationWindowToggle />
      <EmployeesList />
    </Protected>
  );
}
