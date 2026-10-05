'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { KanbanSquare, Users, FileAudio, CalendarDays, Mic, MessageSquare, Mail, DoorOpen, LogOut, Sparkles } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { AgentMark, IconButton, cx } from '@/components/ui';
import { Avatar } from './avatar';

// Голос — доступен всем, как задачи (раздел 5 ТЗ, скорректировано
// 28.08.2026): черновик-событие для не-OWNER бэкенд сам превращает в
// черновик задачи (см. VoiceService.enforceEventRbac), поэтому пункт меню
// не требует условия на роль — та же логика, что в apps/miniapp/page.tsx.
const NAV_ITEMS = [
  { href: '/tasks', label: 'Задачи', icon: KanbanSquare, ownerOnly: false },
  // Stage 2, Phase M (Web Assistant parity, 22.09.2026) — полноценный
  // AI-чат с историей на сервере (GET/POST /assistant/conversations[...]),
  // доступен всем, как задачи (видимость конкретных tools уже решает
  // backend через buildTools(user)). Legacy /voice ниже намеренно не
  // убран и не редиректится в этом раунде — отдельное решение по спеке.
  { href: '/assistant', label: 'Ассистент', icon: MessageSquare, ownerOnly: false },
  { href: '/voice', label: 'Голос', icon: Mic, ownerOnly: false },
  // ТЗ «Приёмная руководителя» v1.0 (02.10.2026) — доступна всем (сотрудник
  // подаёт обращение, руководитель управляет очередью), видимость действий
  // внутри страницы решает backend по роли, не пункт меню.
  { href: '/reception', label: 'Приёмная', icon: DoorOpen, ownerOnly: false },
  { href: '/calendar', label: 'Календарь', icon: CalendarDays, ownerOnly: true },
  { href: '/meetings', label: 'Встречи', icon: FileAudio, ownerOnly: true },
  // Stage 2, Phase R — почта Mail.ru (личная интеграция руководителя, как Plaud/календарь).
  { href: '/mail', label: 'Почта', icon: Mail, ownerOnly: true },
  { href: '/employees', label: 'Сотрудники', icon: Users, ownerOnly: true },
];

// Дизайн-система «Адъютант» (владелец 04.10.2026, implementation.md шаг 5)
// — порт Sidebar из project/components/src/index.jsx: светлый сайдбар на
// bg, бренд с AgentMark, командная строка «Спросить или найти ⌘K» (та же
// команда работает глобально по Ctrl+K/Cmd+K — см. useEffect ниже), группа
// «Руководитель» перед ownerOnly-пунктами.
//
// «live»-индикатор у «Ассистента» (точка с AgentMark, пока где-то в фоне
// стримится ответ) НЕ реализован — состояние стрима сейчас живёт целиком
// внутри apps/web/src/app/assistant/page.tsx, нет глобального контекста,
// который сайдбар мог бы читать с любой другой страницы. Поднимать его в
// layout-контекст — отдельный, более крупный рефакторинг самой страницы
// ассистента (она и так переписывается в шаге 7), поэтому сознательно
// пропущено здесь, а не сделано наспех.
function useGlobalAssistantShortcut() {
  const router = useRouter();
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        router.push('/assistant');
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [router]);
}

export function Sidebar() {
  const { user, logout } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  useGlobalAssistantShortcut();

  if (!user) return null;

  const isOwner = user.role === 'OWNER';
  const generalItems = NAV_ITEMS.filter((item) => !item.ownerOnly);
  const ownerItems = isOwner ? NAV_ITEMS.filter((item) => item.ownerOnly) : [];

  function renderItem(item: (typeof NAV_ITEMS)[number]) {
    const active = pathname === item.href || pathname.startsWith(item.href + '/');
    const Icon = item.icon;
    return (
      <Link key={item.href} href={item.href} className={cx('ds-nav-item', active && 'is-active')} aria-current={active ? 'page' : undefined}>
        <Icon size={18} strokeWidth={1.75} />
        {item.label}
      </Link>
    );
  }

  return (
    <aside className="ds-sidebar">
      <Link href="/tasks" className="ds-brand">
        <span className="ds-brand-mark">
          <AgentMark size={16} state="idle" />
        </span>
        Адъютант
      </Link>

      <button type="button" className="ds-cmd ds-focusable" onClick={() => router.push('/assistant')}>
        <Sparkles size={16} strokeWidth={1.75} />
        <span>Спросить или найти</span>
        <span className="ds-kbd">⌘K</span>
      </button>

      <nav>
        {generalItems.map(renderItem)}
        {ownerItems.length > 0 && (
          <>
            <div className="ds-nav-sep" />
            <div className="ds-nav-group">Руководитель</div>
            {ownerItems.map(renderItem)}
          </>
        )}
      </nav>

      <div className="ds-sidebar-foot">
        <Avatar name={user.fullName} size={30} />
        <div className="ds-sidebar-user">
          <b>{user.fullName}</b>
          <span>{isOwner ? 'Руководитель' : 'Подчинённый'}</span>
        </div>
        <IconButton icon={LogOut} label="Выйти" size="sm" onClick={logout} />
      </div>
    </aside>
  );
}
