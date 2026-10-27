'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api, ApiError } from '@/lib/api';
import { rememberAfterLogin, useAuth } from '@/lib/auth-context';
import { AuthBrand } from '@/components/brand/logo';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

// Подключение Claude к Адъютанту (MCP, владелец 22.10.2026). Сюда
// перенаправляет GET /oauth/authorize API с параметрами OAuth; после
// «Разрешить» API выдаёт одноразовый код и адрес возврата в Claude.

const OAUTH_PARAMS = ['client_id', 'redirect_uri', 'code_challenge', 'code_challenge_method', 'resource', 'state', 'scope', 'response_type'];

type Describe = { clientName: string; allowed: boolean } | { error: string };

function ConnectView() {
  const { user, loading, logout } = useAuth();
  const router = useRouter();
  const search = useSearchParams();
  const [info, setInfo] = useState<Describe | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const params: Record<string, string> = {};
  for (const key of OAUTH_PARAMS) {
    const value = search.get(key);
    if (value) params[key] = value;
  }
  const query = new URLSearchParams(params).toString();

  useEffect(() => {
    if (loading) return;
    if (!user) {
      rememberAfterLogin(`/connect?${query}`);
      router.replace('/login');
      return;
    }
    api
      .get<Describe>(`/oauth/authorize/describe?${query}`)
      .then(setInfo)
      .catch((err) => setInfo({ error: err instanceof ApiError ? err.message : 'Не удалось проверить запрос' }));
  }, [loading, user, query, router]);

  async function approve() {
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ redirectTo?: string; error?: string }>('/oauth/authorize/approve', params);
      if (res.redirectTo) {
        window.location.assign(res.redirectTo);
        return;
      }
      setError(res.error ?? 'Не удалось подключить');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось подключить');
    }
    setBusy(false);
  }

  function deny() {
    const redirect = params.redirect_uri;
    if (!redirect || !info || 'error' in info) return;
    const url = new URL(redirect);
    url.searchParams.set('error', 'access_denied');
    if (params.state) url.searchParams.set('state', params.state);
    window.location.assign(url.toString());
  }

  if (loading || !user || !info) return <p className="ds-field-hint">Загрузка…</p>;

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <AuthBrand />
        <div className="ds-card">
          <h1 style={{ fontSize: 28, lineHeight: '34px', fontWeight: 650, letterSpacing: '-0.02em' }}>Подключение к Адъютанту</h1>
          {'error' in info ? (
            <Alert tone="danger">{info.error}</Alert>
          ) : !info.allowed ? (
            <Alert tone="danger">Подключение внешних ИИ для вашей роли недоступно.</Alert>
          ) : (
            <>
              <p className="auth-subtitle">
                <strong>{info.clientName}</strong> получит доступ к Адъютанту от имени {user.fullName}: сможет читать задачи, календарь, встречи, почту и
                спрашивать юриста — с вашими правами. Изменять данные он не сможет.
              </p>
              <p className="ds-field-hint">Отключить можно в любой момент: «Мой профиль» → «Подключённые приложения».</p>
              {error && <Alert tone="danger">{error}</Alert>}
              <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
                <Button variant="primary" onClick={approve} loading={busy} disabled={busy}>
                  Разрешить
                </Button>
                <Button variant="secondary" onClick={deny} disabled={busy}>
                  Отмена
                </Button>
              </div>
            </>
          )}
          <p className="ds-field-hint" style={{ marginTop: 16 }}>
            Вы вошли как {user.email}.{' '}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                rememberAfterLogin(`/connect?${query}`);
                logout();
              }}
            >
              Войти под другим пользователем
            </Button>
          </p>
        </div>
      </div>
    </div>
  );
}

export default function ConnectPage() {
  return (
    <Suspense fallback={<p className="ds-field-hint">Загрузка…</p>}>
      <ConnectView />
    </Suspense>
  );
}
