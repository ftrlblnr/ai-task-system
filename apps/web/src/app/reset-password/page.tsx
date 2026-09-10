'use client';

import { Suspense, useState, type FormEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api, ApiError } from '@/lib/api';

// Публичная страница — сотрудник переходит сюда по одноразовой ссылке от
// руководителя (владелец 08.09.2026), без предварительного входа (у него
// как раз нет доступа, отсюда и сброс). useSearchParams требует Suspense —
// тот же паттерн, что в app/calendar/page.tsx (?connected=1 от Google).
function ResetPasswordForm() {
  const router = useRouter();
  const token = useSearchParams().get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError('Пароль должен быть не короче 8 символов');
      return;
    }
    if (password !== confirm) {
      setError('Пароли не совпадают');
      return;
    }
    setSubmitting(true);
    try {
      await api.post('/auth/reset-password', { token, newPassword: password });
      setDone(true);
      setTimeout(() => router.push('/login'), 2000);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось сбросить пароль');
    } finally {
      setSubmitting(false);
    }
  }

  if (!token) {
    return (
      <div className="auth-screen">
        <div className="auth-card">
          <div className="auth-mark">AI</div>
          <div className="card">
            <h1>Ссылка недействительна</h1>
            <p className="hint">В ссылке нет токена — запросите новую у руководителя.</p>
          </div>
        </div>
      </div>
    );
  }

  if (done) {
    return (
      <div className="auth-screen">
        <div className="auth-card">
          <div className="auth-mark">AI</div>
          <div className="card">
            <h1>Пароль изменён</h1>
            <p className="hint">Сейчас перенаправим на вход…</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="auth-mark">AI</div>
        <form onSubmit={handleSubmit} className="card">
          <h1>Новый пароль</h1>
          <p className="auth-subtitle">Придумайте новый пароль для входа</p>
          <label>
            Новый пароль
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={8}
              required
            />
          </label>
          <label>
            Повторите пароль
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              minLength={8}
              required
            />
          </label>
          {error && <p className="error">{error}</p>}
          <button type="submit" disabled={submitting}>
            {submitting ? 'Сохраняем…' : 'Сохранить и войти'}
          </button>
        </form>
      </div>
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<p className="hint">Загрузка…</p>}>
      <ResetPasswordForm />
    </Suspense>
  );
}
