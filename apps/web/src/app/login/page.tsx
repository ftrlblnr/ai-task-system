'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useAuth } from '@/lib/auth-context';
import { ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { Alert } from '@/components/ui/alert';
import { AgentMark } from '@/components/ui/agent-mark';

export default function LoginPage() {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(email, password);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось войти');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="auth-screen">
      <div className="auth-card">
        {/* Единственное место в продукте, где метка агента показывается
            крупно вне чата (project/implementation.md, шаг 10). */}
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 16 }}>
          <AgentMark size={40} state="idle" />
        </div>
        <form onSubmit={handleSubmit} className="ds-card">
          <h1 style={{ fontSize: 32, lineHeight: '38px', fontWeight: 650, letterSpacing: '-0.025em' }}>Вход</h1>
          <p className="auth-subtitle">Закрытая система задач — доступ только по приглашению</p>
          <Field label="Email">
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </Field>
          <Field label="Пароль">
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </Field>
          {error && <Alert tone="danger">{error}</Alert>}
          <Button type="submit" variant="primary" block disabled={submitting} loading={submitting}>
            Войти
          </Button>
        </form>
        <p className="ds-field-hint" style={{ textAlign: 'center', marginTop: 12 }}>
          Нет аккаунта? <Link href="/register">Зарегистрироваться</Link>
        </p>
      </div>
    </div>
  );
}
