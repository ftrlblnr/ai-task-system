'use client';

import { useState, type FormEvent } from 'react';
import { useAuth } from '@/lib/auth-context';
import { ApiError } from '@/lib/api';

// Показывается только когда initData пуста (запущено не из Telegram —
// обычный браузер, в т.ч. локальная разработка без настроенного бота).
// Внутри реального Telegram Mini App пользователь этот экран не видит —
// auth-context.tsx входит через initData автоматически.
export function LoginScreen() {
  const { loginWithPassword } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await loginWithPassword(email, password);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось войти');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="center-screen">
      <div className="login-card">
        <h1>AI Task System</h1>
        <p className="hint">
          Открыто не из Telegram — вход по email/паролю (только для разработки; в самом Telegram
          вход происходит автоматически).
        </p>
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <input
            type="password"
            placeholder="Пароль"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          {error && <p className="error">{error}</p>}
          <button type="submit" className="btn" disabled={busy}>
            {busy ? 'Входим…' : 'Войти'}
          </button>
        </form>
      </div>
    </div>
  );
}
