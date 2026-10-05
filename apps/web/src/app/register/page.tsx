'use client';

import { useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import type { LoginResponse, RegisterInput, RegisterOptions, RegistrationWindowStatus } from '@ai-task-system/shared-types';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { Alert } from '@/components/ui/alert';

// Самостоятельная регистрация (владелец 02.10.2026) — временное окно,
// открывается/закрывается переключателем на странице «Сотрудники»
// (apps/web/src/app/employees/page.tsx). Публичная страница, без
// <Protected> — тот же принцип, что /login и /reset-password.
//
// Поля — как при создании сотрудника руководителем (employees/new/page.tsx),
// кроме роли (всегда EMPLOYEE на бэкенде, здесь её вообще нет в форме) и
// кроме "+ Новая должность/направление…" — анонимный посетитель выбирает
// только из уже существующего списка, создавать новые организационные
// единицы без входа нельзя (POST /positions, POST /directions остаются
// только для OWNER); если нужного варианта нет — руководитель назначит его
// позже на карточке сотрудника.
function RegisterForm() {
  const { applySession } = useAuth();
  const [windowStatus, setWindowStatus] = useState<RegistrationWindowStatus | null>(null);
  const [options, setOptions] = useState<RegisterOptions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [fullName, setFullName] = useState('');
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [positionId, setPositionId] = useState('');
  const [directionId, setDirectionId] = useState('');

  useEffect(() => {
    api.get<RegistrationWindowStatus>('/auth/registration-window').then(setWindowStatus).catch(() => setWindowStatus({ isOpen: false }));
    api.get<RegisterOptions>('/auth/register/options').then(setOptions).catch(() => {});
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const payload: RegisterInput = {
        fullName,
        login,
        password,
        positionId: positionId || undefined,
        directionId: directionId || undefined,
      };
      const res = await api.post<LoginResponse>('/auth/register', payload);
      applySession(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось зарегистрироваться');
      setSubmitting(false);
    }
  }

  if (!windowStatus) {
    return <p className="ds-field-hint">Загрузка…</p>;
  }

  if (!windowStatus.isOpen) {
    return (
      <div className="ds-card">
        <h1>Регистрация закрыта</h1>
        <p className="ds-field-hint">Самостоятельная регистрация сейчас недоступна — обратитесь к руководителю.</p>
        <p className="ds-field-hint" style={{ marginTop: 12 }}>
          <Link href="/login">Вернуться ко входу</Link>
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="ds-card">
      <h1>Регистрация</h1>
      <p className="auth-subtitle">
        Придумайте логин и пароль — ими же вы войдёте в Mini App в Telegram, это свяжет аккаунты
      </p>

      <Field label="ФИО">
        <Input value={fullName} onChange={(e) => setFullName(e.target.value)} required />
      </Field>

      <Field label="Логин">
        <Input value={login} onChange={(e) => setLogin(e.target.value)} minLength={3} maxLength={100} required />
      </Field>

      <Field label="Пароль">
        <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} required />
      </Field>

      <Field label="Должность">
        <Select
          value={positionId}
          onChange={(e) => setPositionId(e.target.value)}
          options={[{ value: '', label: '—' }, ...(options?.positions.map((p) => ({ value: p.id, label: p.title })) ?? [])]}
        />
      </Field>

      <Field label="Направление">
        <Select
          value={directionId}
          onChange={(e) => setDirectionId(e.target.value)}
          options={[{ value: '', label: '—' }, ...(options?.directions.map((d) => ({ value: d.id, label: d.title })) ?? [])]}
        />
      </Field>

      {error && <Alert tone="danger">{error}</Alert>}

      <Button type="submit" variant="primary" block disabled={submitting} loading={submitting}>
        Зарегистрироваться
      </Button>

      <p className="ds-field-hint" style={{ textAlign: 'center', marginTop: 12 }}>
        Уже есть аккаунт? <Link href="/login">Войти</Link>
      </p>
    </form>
  );
}

export default function RegisterPage() {
  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="auth-mark">AI</div>
        <RegisterForm />
      </div>
    </div>
  );
}
