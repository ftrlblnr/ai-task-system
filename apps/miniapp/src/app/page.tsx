'use client';

import { useAuth } from '@/lib/auth-context';
import { LoginScreen } from '@/components/login-screen';
import { LinkScreen } from '@/components/link-screen';
import { CalendarDays, DoorOpen, ListChecks, Mic, Plane, Sun } from 'lucide-react';
import { AppShell, type AppSection, type SectionKey } from '@/components/app-shell';
import { TodayScreen } from '@/components/today-screen';
import { TasksScreen } from '@/components/tasks-screen';
import { CalendarScreen } from '@/components/calendar-screen';
import { AssistantScreen } from '@/components/assistant-screen';
import { ReceptionScreen } from '@/components/reception-screen';
import { TripsScreen } from '@/components/trips-screen';
import { Alert } from '@/components/ui/alert';
import { isManagerRole } from '@ai-task-system/shared-types';

export default function Home() {
  const { user, loading, error, isTelegram, needsLink } = useAuth();

  if (loading) {
    return (
      <div className="center-screen">
        <p className="ds-field-hint">Загрузка…</p>
      </div>
    );
  }

  // Владелец 02.10.2026 — NO_EMPLOYEE_LINKED: внутри Telegram, но аккаунт
  // ещё не привязан. Проверяется раньше error — auth-context ставит ровно
  // одно из needsLink/error/user после попытки входа.
  if (needsLink) {
    return <LinkScreen />;
  }

  if (error) {
    return (
      <div className="center-screen" style={{ padding: 16 }}>
        <Alert tone="danger">{error}</Alert>
      </div>
    );
  }

  if (!user) {
    // isTelegram=true, но авторизация ещё не завершилась/провалилась
    // молча — не должно происходить (auth-context выставляет либо error,
    // либо needsLink, либо user), но на всякий случай не показываем пустой
    // экран.
    if (isTelegram) return null;
    return <LoginScreen />;
  }

  // Разделы и нижняя панель — редизайн M1 (владелец 23.10.2026,
  // задание MINIAPP_REDESIGN.md §4.1).
  //
  // Календарь — личный календарь руководителя (раздел 5 ТЗ, RBAC на
  // бэкенде тоже OWNER-only) — подчинённому раздел не показываем, а не
  // показываем и получаем 403.
  //
  // Ассистент (Stage 2, Phase D; Phase H — голос объединён в этот же экран)
  // доступен всем: черновик-событие для не-OWNER бэкенд сам превращает в
  // черновик задачи (VoiceService.enforceEventRbac).
  //
  // Приёмная (ТЗ v1.0, 02.10.2026) — подать вопрос может любой, включая
  // OWNER; очередь руководителя пока только в Web App.
  //
  // Поездки (ТЗ 08.10.2026) доступны всем: создатель и путешествующий
  // руководитель могут быть разными людьми, видимость решает backend через
  // TripMember. У руководителя пятое место панели занято Календарём, поэтому
  // Поездки открываются строкой «Разделы» на «Сегодня».
  const manager = isManagerRole(user.role);
  const sections: AppSection[] = [
    { key: 'today', label: 'Сегодня', icon: Sun, render: (active) => <TodayScreen active={active} /> },
    { key: 'tasks', label: 'Задачи', icon: ListChecks, render: (active) => <TasksScreen active={active} /> },
    { key: 'assistant', label: 'Ассистент', icon: Mic, fill: true, render: (active) => <AssistantScreen active={active} /> },
    ...(manager ? [{ key: 'calendar', label: 'Календарь', icon: CalendarDays, render: (active: boolean) => <CalendarScreen active={active} /> } as AppSection] : []),
    { key: 'reception', label: 'Приёмная', icon: DoorOpen, render: (active) => <ReceptionScreen active={active} /> },
    { key: 'trips', label: 'Поездки', icon: Plane, render: (active) => <TripsScreen active={active} /> },
  ];
  const nav: SectionKey[] = manager
    ? ['today', 'tasks', 'assistant', 'calendar', 'reception']
    : ['today', 'tasks', 'assistant', 'reception', 'trips'];

  return <AppShell sections={sections} nav={nav} />;
}
