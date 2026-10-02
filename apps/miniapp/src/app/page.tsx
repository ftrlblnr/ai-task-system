'use client';

import { useAuth } from '@/lib/auth-context';
import { LoginScreen } from '@/components/login-screen';
import { LinkScreen } from '@/components/link-screen';
import { SwipeShell, type SwipeScreen } from '@/components/swipe-shell';
import { TasksScreen } from '@/components/tasks-screen';
import { CalendarScreen } from '@/components/calendar-screen';
import { AssistantScreen } from '@/components/assistant-screen';
import { ReceptionScreen } from '@/components/reception-screen';

export default function Home() {
  const { user, loading, error, isTelegram, needsLink } = useAuth();

  if (loading) {
    return (
      <div className="center-screen">
        <p className="hint">Загрузка…</p>
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
      <div className="center-screen">
        <p className="error">{error}</p>
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

  // Календарь — личный календарь руководителя (раздел 5 ТЗ, RBAC на
  // бэкенде тоже OWNER-only) — подчинённому просто не показываем вкладку,
  // а не показываем и получаем 403.
  //
  // Ассистент (Stage 2, Phase D, владелец 15.09.2026; Phase H, владелец
  // 18.09.2026 — голос объединён в этот же экран, отдельной вкладки
  // «Голос» больше нет, микрофон теперь в composer'е AssistantScreen).
  // Доступен всем — голос и раньше был доступен всем (раздел 5 ТЗ,
  // скорректировано 28.08.2026, черновик-событие для не-OWNER бэкенд сам
  // превращает в черновик задачи, см. VoiceService.enforceEventRbac),
  // контроллер без @Roles(...).
  const screens: SwipeScreen[] = [{ key: 'tasks', label: 'Задачи', content: <TasksScreen /> }];
  if (user.role === 'OWNER') {
    screens.push({ key: 'calendar', label: 'Календарь', content: <CalendarScreen /> });
  }
  // ТЗ «Приёмная руководителя» v1.0 (02.10.2026) — доступна всем, подать
  // вопрос может и OWNER (раздел 4 ТЗ: "Да" для обеих ролей), очередь
  // руководителя — только Web App (раздел 13 ТЗ не описывает её для
  // Mini App).
  screens.push({ key: 'reception', label: 'Приёмная', content: <ReceptionScreen /> });
  screens.push({ key: 'assistant', label: 'Ассистент', content: <AssistantScreen /> });

  return <SwipeShell screens={screens} />;
}
