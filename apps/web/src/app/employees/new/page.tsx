'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import type { CreateEmployeeInput, EmployeeProfile, Position, Role } from '@ai-task-system/shared-types';
import { api, ApiError } from '@/lib/api';
import { Protected } from '@/components/protected';
import { generatePassword } from '@/lib/generate-password';

const NEW_POSITION_VALUE = '__new__';

function NewEmployeeForm() {
  const router = useRouter();
  const [positions, setPositions] = useState<Position[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState(() => generatePassword());
  const [positionId, setPositionId] = useState('');
  const [newPositionTitle, setNewPositionTitle] = useState('');
  const [role, setRole] = useState<Role>('EMPLOYEE');
  const [isProfileAdmin, setIsProfileAdmin] = useState(false);

  useEffect(() => {
    api.get<Position[]>('/positions').then(setPositions).catch(() => {});
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      let finalPositionId = positionId || undefined;
      if (positionId === NEW_POSITION_VALUE) {
        if (!newPositionTitle.trim()) throw new ApiError('Укажите название новой должности', 400);
        const created = await api.post<Position>('/positions', { title: newPositionTitle.trim() });
        finalPositionId = created.id;
      }

      const payload: CreateEmployeeInput = {
        fullName,
        email,
        password,
        positionId: finalPositionId,
        role,
        isProfileAdmin,
      };
      const created = await api.post<EmployeeProfile>('/employees', payload);
      router.push(`/employees/${created.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось создать сотрудника');
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="card form-card">
      <label>
        ФИО
        <input value={fullName} onChange={(e) => setFullName(e.target.value)} required />
      </label>

      <label>
        Email
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
      </label>

      <label>
        Пароль (сообщите сотруднику лично — сменить его пока нельзя из интерфейса)
        <div className="input-row">
          <input
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={8}
            required
          />
          <button type="button" className="btn-secondary" onClick={() => setPassword(generatePassword())}>
            Сгенерировать
          </button>
        </div>
      </label>

      <label>
        Должность
        <select value={positionId} onChange={(e) => setPositionId(e.target.value)}>
          <option value="">—</option>
          {positions.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title}
            </option>
          ))}
          <option value={NEW_POSITION_VALUE}>+ Новая должность…</option>
        </select>
      </label>

      {positionId === NEW_POSITION_VALUE && (
        <label>
          Название новой должности
          <input value={newPositionTitle} onChange={(e) => setNewPositionTitle(e.target.value)} required />
        </label>
      )}

      <label>
        Роль в системе
        <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
          <option value="EMPLOYEE">Подчинённый — видит только свои задачи</option>
          <option value="OWNER">Руководитель — видит и подтверждает всё</option>
        </select>
      </label>

      <label className="checkbox-label">
        <input
          type="checkbox"
          checked={isProfileAdmin}
          onChange={(e) => setIsProfileAdmin(e.target.checked)}
        />
        Администратор профилей (ведёт компетенции сотрудников)
      </label>

      {error && <p className="error">{error}</p>}

      <button type="submit" disabled={submitting}>
        {submitting ? 'Создаём…' : 'Создать сотрудника'}
      </button>
    </form>
  );
}

export default function NewEmployeePage() {
  return (
    <Protected requireRole="OWNER">
      <Link href="/employees" className="back-link">
        <ArrowLeft size={14} strokeWidth={2.25} />
        Сотрудники
      </Link>
      <h1>Новый сотрудник</h1>
      <p className="page-subtitle">Заведите профиль — компетенции добавите на карточке сотрудника.</p>
      <NewEmployeeForm />
    </Protected>
  );
}
