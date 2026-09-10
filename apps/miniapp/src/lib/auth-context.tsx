'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { LoginResponse } from '@ai-task-system/shared-types';
import { api, ApiError } from './api';
import { getInitData, initTelegramChrome } from './telegram';

type CurrentUser = LoginResponse['user'];

interface AuthState {
  user: CurrentUser | null;
  loading: boolean;
  error: string | null;
  // Пусто вне Telegram (initData недоступна) — признак, что нужен
  // фолбэк на email/пароль (см. login-screen.tsx). Внутри настоящего
  // Telegram Mini App всегда true.
  isTelegram: boolean;
  loginWithPassword: (email: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isTelegram, setIsTelegram] = useState(false);

  useEffect(() => {
    initTelegramChrome();
    const initData = getInitData();

    if (!initData) {
      // Не запущено из Telegram — обычный браузер (в т.ч. локальная
      // разработка без бота). Показываем форму email/пароль вместо
      // бесконечной загрузки. Чтение Telegram WebApp SDK на монтировании —
      // синхронизация с внешней системой, не подстройка под проп (react-
      // hooks/set-state-in-effect, первый реальный прогон lint в CI, аудит
      // 10.09.2026, п. 5.2 — ложное срабатывание, тот же случай, что в
      // apps/web/src/lib/auth-context.tsx).
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setIsTelegram(false);
      setLoading(false);
      return;
    }

    setIsTelegram(true);
    api
      .post<LoginResponse>('/auth/telegram', { initData })
      .then((res) => {
        sessionStorage.setItem('accessToken', res.accessToken);
        setUser(res.user);
      })
      .catch((err) => {
        setError(err instanceof ApiError ? err.message : 'Не удалось войти через Telegram');
      })
      .finally(() => setLoading(false));
  }, []);

  async function loginWithPassword(email: string, password: string) {
    const res = await api.post<LoginResponse>('/auth/login', { email, password });
    sessionStorage.setItem('accessToken', res.accessToken);
    setUser(res.user);
  }

  function logout() {
    sessionStorage.removeItem('accessToken');
    setUser(null);
  }

  return (
    <AuthContext.Provider value={{ user, loading, error, isTelegram, loginWithPassword, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth должен использоваться внутри AuthProvider');
  return ctx;
}
