'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import type { LoginResponse } from '@ai-task-system/shared-types';
import { api } from './api';

type CurrentUser = LoginResponse['user'];

interface AuthState {
  user: CurrentUser | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  useEffect(() => {
    // Чтение localStorage на монтировании — как раз тот случай, для
    // которого эффекты существуют (синхронизация с внешней системой, не
    // React-состоянием), а не "подстройка состояния под изменившийся
    // проп" — правило react-hooks/set-state-in-effect (первый реальный
    // прогон lint в CI, аудит 10.09.2026, п. 5.2) не различает эти два
    // случая эвристически, здесь ложное срабатывание.
    const stored = localStorage.getItem('user');
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (stored) setUser(JSON.parse(stored));
    setLoading(false);
  }, []);

  async function login(email: string, password: string) {
    const res = await api.post<LoginResponse>('/auth/login', { email, password });
    // MVP: токен в localStorage. Перед реальным продом заменить на httpOnly
    // cookie — раздел 15 ТЗ требует контроля доступа на уровне API, а не
    // только UI, localStorage слабее к XSS.
    localStorage.setItem('accessToken', res.accessToken);
    localStorage.setItem('user', JSON.stringify(res.user));
    setUser(res.user);
    router.push('/tasks');
  }

  function logout() {
    localStorage.removeItem('accessToken');
    localStorage.removeItem('user');
    setUser(null);
    router.push('/login');
  }

  return <AuthContext.Provider value={{ user, loading, login, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth должен использоваться внутри AuthProvider');
  return ctx;
}
