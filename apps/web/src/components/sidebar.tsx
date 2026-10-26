'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  BarChart3,
  BookOpen,
  CalendarDays,
  CircleCheckBig,
  Clock,
  DoorOpen,
  LayoutGrid,
  Lightbulb,
  LogOut,
  Mail,
  Menu,
  Mic,
  Monitor,
  Moon,
  Plane,
  Scale,
  Sparkles,
  Sun,
  Users,
  X,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { ROLE_LABELS, isManagerRole } from '@ai-task-system/shared-types';
import { useAuth } from '@/lib/auth-context';
import { api } from '@/lib/api';
import { applyTheme, readTheme, type ThemeChoice } from '@/lib/theme';
import { IconButton, cx } from '@/components/ui';
import { Avatar } from './avatar';

// Меню по группам (редизайн web W1, docs/WEB_REDESIGN.md §4.1). Права —
// как были: «Пульт» — только руководителю (OWNER, ролевая модель
// 20.10.2026), manager-пункты — руководителю и администратору, остальное —
// всем (видимость данных внутри разделов решает backend). Бейджи — W5.

type Access = 'all' | 'manager' | 'owner' | 'legal';

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  access: Access;
}

const NAV_GROUPS: { title: string; items: NavItem[] }[] = [
  {
    title: 'Работа',
    items: [
      { href: '/', label: 'Пульт', icon: LayoutGrid, access: 'owner' },
      { href: '/tasks', label: 'Задачи', icon: CircleCheckBig, access: 'all' },
      // Приёмная (02.10.2026) и поездки (08.10.2026) — всем: сотрудник подаёт
      // обращение / едет сам, видимость решает backend.
      { href: '/reception', label: 'Приёмная', icon: DoorOpen, access: 'all' },
      { href: '/trips', label: 'Поездки', icon: Plane, access: 'all' },
    ],
  },
  {
    title: 'Информация',
    items: [
      { href: '/calendar', label: 'Календарь', icon: CalendarDays, access: 'manager' },
      { href: '/meetings', label: 'Встречи', icon: Mic, access: 'manager' },
      { href: '/mail', label: 'Почта', icon: Mail, access: 'manager' },
    ],
  },
  {
    title: 'Агент',
    items: [
      { href: '/memory', label: 'Память', icon: BookOpen, access: 'manager' },
      { href: '/skills', label: 'Навыки', icon: Zap, access: 'manager' },
      { href: '/routines', label: 'Регламенты', icon: Clock, access: 'manager' },
      { href: '/recommendations', label: 'Рекомендации', icon: Lightbulb, access: 'manager' },
      { href: '/ai-usage', label: 'Расход ИИ', icon: BarChart3, access: 'manager' },
      // Агент-юрист — виден, только если бэкенд включил раздел для роли
      // (GET /legal/status: LEGAL_AGENT_ENABLED + LEGAL_AGENT_ROLES).
      { href: '/legal', label: 'Юрист', icon: Scale, access: 'legal' },
    ],
  },
  {
    title: 'Команда',
    items: [{ href: '/employees', label: 'Сотрудники', icon: Users, access: 'manager' }],
  },
];

const THEME_NEXT: Record<ThemeChoice, ThemeChoice> = { system: 'light', light: 'dark', dark: 'system' };
const THEME_LABEL: Record<ThemeChoice, string> = { system: 'как в системе', light: 'светлая', dark: 'тёмная' };
const THEME_ICON: Record<ThemeChoice, LucideIcon> = { system: Monitor, light: Sun, dark: Moon };

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

// Ctrl+K / Cmd+K — «Спросить агента» с любой страницы. Пока ведёт на
// /assistant; панель агента справа — W2.
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

// Тема: один переключатель по кругу «как в системе → светлая → тёмная»,
// выбор в localStorage (lib/theme.ts).
function ThemeToggle() {
  const [theme, setTheme] = useState<ThemeChoice>(readTheme);
  const next = THEME_NEXT[theme];
  return (
    <IconButton
      icon={THEME_ICON[theme]}
      label={`Тема: ${THEME_LABEL[theme]}. Переключить на «${THEME_LABEL[next]}»`}
      size="sm"
      onClick={() => {
        setTheme(next);
        applyTheme(next);
      }}
    />
  );
}

export function Sidebar() {
  const { user, logout } = useAuth();
  const pathname = usePathname();
  useGlobalAssistantShortcut();
  const legalEnabled = useLegalEnabled(user?.id);
  // Узкий экран (<760px): меню — выезжающая панель за кнопкой-бургером.
  const [open, setOpen] = useState(false);

  if (!user) return null;

  const isOwner = user.role === 'OWNER';
  const isManager = isManagerRole(user.role);
  const allowed = (access: Access) =>
    access === 'all' || (access === 'manager' && isManager) || (access === 'owner' && isOwner) || (access === 'legal' && legalEnabled);

  function isActive(href: string) {
    return href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(href + '/');
  }

  return (
    <>
      <div className="ds-mobilebar">
        <IconButton
          icon={Menu}
          label="Меню"
          onClick={() => setOpen(true)}
        />
        <Link href="/" className="ds-brand ds-brand-compact">
          <span className="ds-brand-mark">А</span>
          Адъютант
        </Link>
      </div>
      {open && <div className="ds-sidebar-scrim" onClick={() => setOpen(false)} aria-hidden="true" />}

      {/* Клик по любой ссылке меню закрывает выезжающую панель. */}
      <aside className={cx('ds-sidebar', open && 'is-open')} onClick={(e) => (e.target as HTMLElement).closest('a') && setOpen(false)}>
        <div className="ds-sidebar-top">
          <Link href="/" className="ds-brand">
            <span className="ds-brand-mark">А</span>
            <span className="ds-brand-text">
              Адъютант
              <small>GLB ENGINEERING</small>
            </span>
          </Link>
          <span className="ds-sidebar-close">
            <IconButton icon={X} label="Закрыть меню" size="sm" onClick={() => setOpen(false)} />
          </span>
        </div>

        <Link href="/assistant" className="ds-cmd">
          <Sparkles size={16} strokeWidth={1.9} />
          <span>Спросить агента</span>
          <kbd className="ds-kbd">Ctrl K</kbd>
        </Link>

        <nav className="ds-nav">
          {NAV_GROUPS.map((group) => {
            const items = group.items.filter((item) => allowed(item.access));
            if (items.length === 0) return null;
            return (
              <div key={group.title} className="ds-nav-section">
                <div className="ds-nav-group">{group.title}</div>
                {items.map((item) => {
                  const active = isActive(item.href);
                  const Icon = item.icon;
                  return (
                    <Link key={item.href} href={item.href} className={cx('ds-nav-item', active && 'is-active')} aria-current={active ? 'page' : undefined}>
                      <Icon size={17} strokeWidth={1.9} />
                      {item.label}
                    </Link>
                  );
                })}
              </div>
            );
          })}
        </nav>

        <div className="ds-sidebar-foot">
          <Link href="/profile" className="ds-sidebar-profile" title="Мой профиль">
            <Avatar id={user.id} name={user.fullName} size={34} />
            <div className="ds-sidebar-user">
              <b>{user.fullName}</b>
              <span>{ROLE_LABELS[user.role]}</span>
            </div>
          </Link>
          <ThemeToggle />
          <IconButton icon={LogOut} label="Выйти" size="sm" onClick={logout} />
        </div>
      </aside>
    </>
  );
}
