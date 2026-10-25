'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { KanbanSquare, Users, FileAudio, CalendarDays, MessageSquare, Mail, DoorOpen, LogOut, LayoutDashboard, Plane, Scale, Gauge, Brain } from 'lucide-react';
import { ROLE_LABELS, isManagerRole } from '@ai-task-system/shared-types';
import { useAuth } from '@/lib/auth-context';
import { api } from '@/lib/api';
import { AgentMark, IconButton, cx } from '@/components/ui';
import { Avatar } from './avatar';

// Голос — доступен всем, как задачи (раздел 5 ТЗ, скорректировано
// 28.08.2026): черновик-событие для не-OWNER бэкенд сам превращает в
// черновик задачи (см. VoiceService.enforceEventRbac), поэтому пункт меню
// не требует условия на роль — та же логика, что в apps/miniapp/page.tsx.
// «Стол руководителя» (ТЗ v1.0, 05.10.2026) — первый пункт меню, только
// OWNER (раздел 4 ТЗ). Рендерится отдельно от generalItems/ownerItems ниже
// (а не как обычный ownerOnly-пункт), чтобы быть визуально ПЕРВЫМ даже при
// активной группировке «Руководитель» после разделителя — сам список
// NAV_ITEMS начинается с "Задачи" и это не должно меняться для остальных.
const DASHBOARD_ITEM = { href: '/', label: 'Стол руководителя', icon: LayoutDashboard, ownerOnly: true };

// Stage 2, Phase M (Web Assistant parity, 22.09.2026) — полноценный
// AI-чат с историей на сервере (GET/POST /assistant/conversations[...]),
// доступен всем, как задачи (видимость конкретных tools уже решает
// backend через buildTools(user)). Отдельная страница /voice убрана
// (владелец 05.10.2026) — голос и так доступен внутри Ассистента
// (микрофон в композере, тот же VoiceService). Владелец 20.10.2026 —
// стоит над меню на месте бывшей командной строки «Спросить или найти»,
// отдельно от остальных пунктов.
const ASSISTANT_ITEM = { href: '/assistant', label: 'Ассистент', icon: MessageSquare, ownerOnly: false };

// Агент-юрист (этап 4 handoff) — пункт виден, только если бэкенд включил
// раздел для роли пользователя (GET /legal/status: LEGAL_AGENT_ENABLED +
// LEGAL_AGENT_ROLES), остальные /legal/* для них отвечают 404.
const LEGAL_ITEM = { href: '/legal', label: 'Юрист', icon: Scale, ownerOnly: false };

function useLegalEnabled(userId: string | undefined): boolean {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    api
      .get<{ enabled: boolean }>('/legal/status')
      .then((s) => !cancelled && setEnabled(s.enabled))
      .catch(() => !cancelled && setEnabled(false));
    return () => {
      cancelled = true;
    };
  }, [userId]);
  return enabled;
}

const NAV_ITEMS = [
  { href: '/tasks', label: 'Задачи', icon: KanbanSquare, ownerOnly: false },
  // ТЗ «Приёмная руководителя» v1.0 (02.10.2026) — доступна всем (сотрудник
  // подаёт обращение, руководитель управляет очередью), видимость действий
  // внутри страницы решает backend по роли, не пункт меню.
  { href: '/reception', label: 'Приёмная', icon: DoorOpen, ownerOnly: false },
  // Агент поездок (ТЗ 08.10.2026) — доступен всем: создатель и путешествующий
  // руководитель могут быть разными людьми (раздел 9 ТЗ), видимость конкретных
  // поездок решает backend через TripMember, не пункт меню.
  { href: '/trips', label: 'Поездки', icon: Plane, ownerOnly: false },
  { href: '/calendar', label: 'Календарь', icon: CalendarDays, ownerOnly: true },
  { href: '/meetings', label: 'Встречи', icon: FileAudio, ownerOnly: true },
  // Stage 2, Phase R — почта Mail.ru (личная интеграция руководителя, как Plaud/календарь).
  { href: '/mail', label: 'Почта', icon: Mail, ownerOnly: true },
  { href: '/employees', label: 'Сотрудники', icon: Users, ownerOnly: true },
  // ARMS, фаза 1 — что ассистент помнит о руководителе.
  { href: '/memory', label: 'Память', icon: Brain, ownerOnly: true },
  // ARMS, фаза 2 — сколько стоят функции ИИ и где не работает кэш.
  { href: '/ai-usage', label: 'Расход ИИ', icon: Gauge, ownerOnly: true },
];

// Дизайн-система «Адъютант» (владелец 04.10.2026, implementation.md шаг 5)
// — порт Sidebar из project/components/src/index.jsx: светлый сайдбар на
// bg, бренд с AgentMark, «Ассистент» сразу под брендом (Ctrl+K/Cmd+K
// открывает его глобально — см. useEffect ниже), группа «Руководитель»
// перед ownerOnly-пунктами.
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
  useGlobalAssistantShortcut();
  const legalEnabled = useLegalEnabled(user?.id);

  if (!user) return null;

  // Ролевая модель 20.10.2026: «Стол руководителя» — только руководителю,
  // остальные разделы руководства (ownerOnly) — и администратору.
  const isOwner = user.role === 'OWNER';
  const generalItems = NAV_ITEMS.filter((item) => !item.ownerOnly);
  const ownerItems = isManagerRole(user.role) ? NAV_ITEMS.filter((item) => item.ownerOnly) : [];

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
      <Link href="/" className="ds-brand">
        <span className="ds-brand-mark">
          <AgentMark size={16} state="idle" />
        </span>
        Адъютант
      </Link>

      <nav style={{ marginBottom: 'var(--space-4)' }}>{renderItem(ASSISTANT_ITEM)}</nav>

      <nav>
        {isOwner && renderItem(DASHBOARD_ITEM)}
        {generalItems.map(renderItem)}
        {legalEnabled && renderItem(LEGAL_ITEM)}
        {ownerItems.length > 0 && (
          <>
            <div className="ds-nav-sep" />
            <div className="ds-nav-group">Управление</div>
            {ownerItems.map(renderItem)}
          </>
        )}
      </nav>

      <div className="ds-sidebar-foot">
        <Link href="/profile" className="ds-sidebar-profile" title="Мой профиль">
          <Avatar id={user.id} name={user.fullName} size={30} />
          <div className="ds-sidebar-user">
            <b>{user.fullName}</b>
            <span>{ROLE_LABELS[user.role]}</span>
          </div>
        </Link>
        <IconButton icon={LogOut} label="Выйти" size="sm" onClick={logout} />
      </div>
    </aside>
  );
}
