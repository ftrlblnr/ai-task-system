'use client';

import { useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import type { LoginResponse, RegisterInput, RegisterOptions, RegistrationWindowStatus } from '@ai-task-system/shared-types';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';

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
    return <p className="hint">Загрузка…</p>;
  }

  if (!windowStatus.isOpen) {
    return (
      <div className="card">
        <h1>Регистрация закрыта</h1>
        <p className="hint">Самостоятельная регистрация сейчас недоступна — обратитесь к руководителю.</p>
        <p className="hint" style={{ marginTop: 12 }}>
          <Link href="/login">Вернуться ко входу</Link>
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="card">
      <h1>Регистрация</h1>
      <p className="auth-subtitle">
        Придумайте логин и пароль — ими же вы войдёте в Mini App в Telegram, это свяжет аккаунты
      </p>

      <label>
        ФИО
        <input value={fullName} onChange={(e) => setFullName(e.target.value)} required />
      </label>

      <label>
        Логин
        <input value={login} onChange={(e) => setLogin(e.target.value)} minLength={3} maxLength={100} required />
      </label>

      <label>
        Пароль
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          minLength={8}
          required
        />
      </label>

      <label>
        Должность
        <select value={positionId} onChange={(e) => setPositionId(e.target.value)}>
          <option value="">—</option>
          {options?.positions.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title}
            </option>
          ))}
        </select>
      </label>

      <label>
        Направление
        <select value={directionId} onChange={(e) => setDirectionId(e.target.value)}>
          <option value="">—</option>
          {options?.directions.map((d) => (
            <option key={d.id} value={d.id}>
              {d.title}
            </option>
          ))}
        </select>
      </label>

      {error && <p className="error">{error}</p>}

      <button type="submit" disabled={submitting}>
        {submitting ? 'Регистрируем…' : 'Зарегистрироваться'}
      </button>

      <p className="hint" style={{ textAlign: 'center', marginTop: 12 }}>
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
