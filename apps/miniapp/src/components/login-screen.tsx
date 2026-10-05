'use client';

import { useState, type FormEvent } from 'react';
import { useAuth } from '@/lib/auth-context';
import { ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/field';
import { Alert } from '@/components/ui/alert';
import { AgentMark } from '@/components/ui/agent-mark';

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
        {/* Единственное место в продукте, где метка агента показывается
            крупно вне чата (project/implementation.md, шаг 10). */}
        <AgentMark size={40} state="idle" />
        <h1 style={{ fontSize: 32, lineHeight: '38px', fontWeight: 650, letterSpacing: '-0.025em' }}>AI Task System</h1>
        <p className="ds-field-hint">
          Открыто не из Telegram — вход по email/паролю (только для разработки; в самом Telegram
          вход происходит автоматически).
        </p>
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          <Input type="password" placeholder="Пароль" value={password} onChange={(e) => setPassword(e.target.value)} required />
          {error && <Alert tone="danger">{error}</Alert>}
          <Button type="submit" variant="primary" block disabled={busy} loading={busy}>
            Войти
          </Button>
        </form>
      </div>
    </div>
  );
}
