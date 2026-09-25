'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { KanbanSquare, Users, FileAudio, CalendarDays, Mic, MessageSquare, Mail, LogOut } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
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
  { href: '/calendar', label: 'Календарь', icon: CalendarDays, ownerOnly: true },
  { href: '/meetings', label: 'Встречи', icon: FileAudio, ownerOnly: true },
  // Stage 2, Phase R — почта Mail.ru (личная интеграция руководителя, как Plaud/календарь).
  { href: '/mail', label: 'Почта', icon: Mail, ownerOnly: true },
  { href: '/employees', label: 'Сотрудники', icon: Users, ownerOnly: true },
];

export function Sidebar() {
  const { user, logout } = useAuth();
  const pathname = usePathname();

  if (!user) return null;

  return (
    <aside className="sidebar">
      <Link href="/tasks" className="sidebar-brand">
        <span className="sidebar-brand-mark">AI</span>
        <span className="sidebar-brand-name">Task System</span>
      </Link>

      <nav className="sidebar-nav">
        {NAV_ITEMS.filter((item) => !item.ownerOnly || user.role === 'OWNER').map((item) => {
          const active = pathname === item.href || pathname.startsWith(item.href + '/');
          const Icon = item.icon;
          return (
            <Link key={item.href} href={item.href} className={`sidebar-nav-item ${active ? 'active' : ''}`}>
              <Icon size={17} strokeWidth={2} />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="sidebar-footer">
        <div className="sidebar-user">
          <Avatar name={user.fullName} size={30} />
          <div className="sidebar-user-info">
            <span className="sidebar-user-name">{user.fullName}</span>
            <span className="sidebar-user-role">{user.role === 'OWNER' ? 'Руководитель' : 'Подчинённый'}</span>
          </div>
        </div>
        <button onClick={logout} className="sidebar-logout" title="Выйти" aria-label="Выйти">
          <LogOut size={16} strokeWidth={2} />
        </button>
      </div>
    </aside>
  );
}
