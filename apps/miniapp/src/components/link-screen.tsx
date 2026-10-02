'use client';

import { useState, type FormEvent } from 'react';
import { useAuth } from '@/lib/auth-context';
import { ApiError } from '@/lib/api';

// Показывается внутри настоящего Telegram, когда этот telegramId ещё ни к
// кому не привязан и нет invite-ссылки от руководителя (NO_EMPLOYEE_LINKED,
// см. auth-context.tsx). Владелец 02.10.2026 — самостоятельная регистрация:
// человек уже завёл логин/пароль на сайте (/register), здесь он входит теми
// же данными, и это одним действием привязывает его telegramId к аккаунту
// (TelegramService.linkViaCredentials), без отдельного приглашения.
export function LinkScreen() {
  const { linkWithPassword } = useAuth();
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await linkWithPassword(login, password);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось войти');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="center-screen">
      <div className="login-card">
        <h1>Вход</h1>
        <p className="hint">
          Этот Telegram-аккаунт ещё не привязан. Войдите логином и паролем, которые вы указали при
          регистрации на сайте — это привяжет аккаунт автоматически.
        </p>
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <input placeholder="Логин" value={login} onChange={(e) => setLogin(e.target.value)} required />
          <input
            type="password"
            placeholder="Пароль"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          {error && <p className="error">{error}</p>}
          <button type="submit" className="btn" disabled={busy}>
            {busy ? 'Входим…' : 'Войти и привязать'}
          </button>
        </form>
      </div>
    </div>
  );
}
