'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import type { CreateEmployeeInput, Direction, EmployeeProfile, Position, Role } from '@ai-task-system/shared-types';
import { MANAGER_ROLES, ROLE_LABELS } from '@ai-task-system/shared-types';
import { useAuth } from '@/lib/auth-context';
import { api, ApiError } from '@/lib/api';
import { Protected } from '@/components/protected';
import { generatePassword } from '@/lib/generate-password';
import { Field, Input, Select } from '@/components/ui/field';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/card';
import { Alert } from '@/components/ui/alert';

const NEW_POSITION_VALUE = '__new__';
const NEW_DIRECTION_VALUE = '__new__';

function NewEmployeeForm() {
  const router = useRouter();
  const { user } = useAuth();
  const [positions, setPositions] = useState<Position[]>([]);
  const [directions, setDirections] = useState<Direction[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState(() => generatePassword());
  const [positionId, setPositionId] = useState('');
  const [newPositionTitle, setNewPositionTitle] = useState('');
  const [directionId, setDirectionId] = useState('');
  const [newDirectionTitle, setNewDirectionTitle] = useState('');
  const [role, setRole] = useState<Role>('EMPLOYEE');

  useEffect(() => {
    api.get<Position[]>('/positions').then(setPositions).catch(() => {});
    api.get<Direction[]>('/directions').then(setDirections).catch(() => {});
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

      let finalDirectionId = directionId || undefined;
      if (directionId === NEW_DIRECTION_VALUE) {
        if (!newDirectionTitle.trim()) throw new ApiError('Укажите название нового направления', 400);
        const created = await api.post<Direction>('/directions', { title: newDirectionTitle.trim() });
        finalDirectionId = created.id;
      }

      const payload: CreateEmployeeInput = {
        fullName,
        email,
        password,
        positionId: finalPositionId,
        directionId: finalDirectionId,
        role,
      };
      const created = await api.post<EmployeeProfile>('/employees', payload);
      router.push(`/employees/${created.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось создать сотрудника');
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="ds-card form-panel">
      <Field label="ФИО">
        <Input value={fullName} onChange={(e) => setFullName(e.target.value)} required />
      </Field>

      <Field label="Email">
        <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
      </Field>

      <Field label="Пароль" hint="Сообщите сотруднику лично">
        <div className="input-row">
          <Input value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} required />
          <Button type="button" variant="secondary" onClick={() => setPassword(generatePassword())}>
            Сгенерировать
          </Button>
        </div>
      </Field>

      <Field label="Должность">
        <Select
          value={positionId}
          onChange={(e) => setPositionId(e.target.value)}
          options={[
            { value: '', label: '—' },
            ...positions.map((p) => ({ value: p.id, label: p.title })),
            { value: NEW_POSITION_VALUE, label: '+ Новая должность…' },
          ]}
        />
      </Field>

      {positionId === NEW_POSITION_VALUE && (
        <Field label="Название новой должности">
          <Input value={newPositionTitle} onChange={(e) => setNewPositionTitle(e.target.value)} required />
        </Field>
      )}

      <Field label="Направление">
        <Select
          value={directionId}
          onChange={(e) => setDirectionId(e.target.value)}
          options={[
            { value: '', label: '—' },
            ...directions.map((d) => ({ value: d.id, label: d.title })),
            { value: NEW_DIRECTION_VALUE, label: '+ Новое направление…' },
          ]}
        />
      </Field>

      {directionId === NEW_DIRECTION_VALUE && (
        <Field label="Название нового направления">
          <Input value={newDirectionTitle} onChange={(e) => setNewDirectionTitle(e.target.value)} required />
        </Field>
      )}

      {/* Администраторов назначает только руководитель (ролевая модель 20.10.2026). */}
      {user?.role === 'OWNER' && (
        <Field label="Роль в системе">
          <Select
            value={role}
            onChange={(e) => setRole(e.target.value as Role)}
            options={[
              { value: 'EMPLOYEE', label: ROLE_LABELS.EMPLOYEE },
              { value: 'ADMIN', label: ROLE_LABELS.ADMIN },
            ]}
          />
        </Field>
      )}

      {error && <Alert tone="danger">{error}</Alert>}

      <div className="panel-actions">
        <Button type="submit" variant="primary" disabled={submitting} loading={submitting}>
          Создать сотрудника
        </Button>
      </div>
    </form>
  );
}

export default function NewEmployeePage() {
  return (
    <Protected requireRole={MANAGER_ROLES}>
      <Link href="/employees" className="back-link">
        <ArrowLeft size={14} strokeWidth={1.75} />
        Сотрудники
      </Link>
      <PageHeader title="Новый сотрудник" description="Компетенции добавите потом на карточке сотрудника." />
      <NewEmployeeForm />
    </Protected>
  );
}
