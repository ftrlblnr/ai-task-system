'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
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
import { ROLE_LABELS, isManagerRole, type MenuBadges } from '@ai-task-system/shared-types';
import { useAuth } from '@/lib/auth-context';
import { api } from '@/lib/api';
import { applyTheme, readTheme, type ThemeChoice } from '@/lib/theme';
import { IconButton, cx } from '@/components/ui';
import { Avatar } from './avatar';
import { useAgentPanel } from './agent-panel/agent-context';
import { useMenuBadges } from './use-menu-badges';
import { LogoGlyph } from './brand/logo';
import { useRealtime } from '@/lib/use-realtime';

// Меню по группам (редизайн web W1, docs/WEB_REDESIGN.md §4.1). Права —
// как были: «Пульт» — только руководителю (OWNER, ролевая модель
// 20.10.2026), manager-пункты — руководителю и администратору, остальное —
// всем (видимость данных внутри разделов решает backend). Бейджи (W5) —
// GET /me/badges: просрочка — акцентом, остальное — тихим счётчиком.

type Access = 'all' | 'manager' | 'owner' | 'legal';

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  access: Access;
  badge?: keyof MenuBadges;
  hot?: boolean;
}

const NAV_GROUPS: { title: string; items: NavItem[] }[] = [
  {
    title: 'Работа',
    items: [
      { href: '/', label: 'Пульт', icon: LayoutGrid, access: 'owner' },
      { href: '/tasks', label: 'Задачи', icon: CircleCheckBig, access: 'all', badge: 'tasksOverdue', hot: true },
      // Приёмная (02.10.2026) и поездки (08.10.2026) — всем: сотрудник подаёт
      // обращение / едет сам, видимость решает backend.
      { href: '/reception', label: 'Приёмная', icon: DoorOpen, access: 'all', badge: 'receptionWaiting' },
      { href: '/trips', label: 'Поездки', icon: Plane, access: 'all' },
    ],
  },
  {
    title: 'Информация',
    items: [
      { href: '/calendar', label: 'Календарь', icon: CalendarDays, access: 'manager' },
      { href: '/meetings', label: 'Встречи', icon: Mic, access: 'manager' },
      { href: '/mail', label: 'Почта', icon: Mail, access: 'manager', badge: 'mailNeedsReply' },
    ],
  },
  {
    title: 'Агент',
    items: [
      { href: '/memory', label: 'Память', icon: BookOpen, access: 'manager' },
      { href: '/skills', label: 'Навыки', icon: Zap, access: 'manager' },
      { href: '/routines', label: 'Регламенты', icon: Clock, access: 'manager' },
      { href: '/recommendations', label: 'Рекомендации', icon: Lightbulb, access: 'manager', badge: 'recommendationsNew' },
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

const BADGE_LABELS: Record<keyof MenuBadges, (n: number) => string> = {
  tasksOverdue: (n) => `просрочено: ${n}`,
  receptionWaiting: (n) => `ожидают: ${n}`,
  mailNeedsReply: (n) => `ждут ответа: ${n}`,
  recommendationsNew: (n) => `новых: ${n}`,
};

// Очередь приёмной меняется мгновенно — бейдж следом, без ожидания опроса.
function ReceptionLive({ onChange }: { onChange: () => void }) {
  useRealtime('reception', onChange);
  return null;
}

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

// Подпись раздела по маршруту — для чипа «Контекст» панели агента.
export function sectionLabel(route: string): string | null {
  for (const group of NAV_GROUPS) {
    const item = group.items.find((i) => i.href === route);
    if (item) return item.label;
  }
  return null;
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
  const { openAndFocus } = useAgentPanel();
  const legalEnabled = useLegalEnabled(user?.id);
  const { badges, refresh: refreshBadges } = useMenuBadges(user?.id, user?.role === 'ADMIN');
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
          <span className="ds-brand-mark">
            <LogoGlyph />
          </span>
          Адъютант
        </Link>
      </div>
      {open && <div className="ds-sidebar-scrim" onClick={() => setOpen(false)} aria-hidden="true" />}

      {/* Клик по любой ссылке меню закрывает выезжающую панель. */}
      <aside className={cx('ds-sidebar', open && 'is-open')} onClick={(e) => (e.target as HTMLElement).closest('a') && setOpen(false)}>
        <div className="ds-sidebar-top">
          <Link href="/" className="ds-brand">
            <span className="ds-brand-mark">
            <LogoGlyph />
          </span>
            <span className="ds-brand-text">
              Адъютант
              <small>GLB ENGINEERING</small>
            </span>
          </Link>
          <span className="ds-sidebar-close">
            <IconButton icon={X} label="Закрыть меню" size="sm" onClick={() => setOpen(false)} />
          </span>
        </div>

        <button
          type="button"
          className="ds-cmd"
          onClick={() => {
            setOpen(false);
            openAndFocus();
          }}
        >
          <Sparkles size={16} strokeWidth={1.9} />
          <span>Спросить агента</span>
          <kbd className="ds-kbd">Ctrl K</kbd>
        </button>

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
                  const count = item.badge ? (badges?.[item.badge] ?? 0) : 0;
                  return (
                    <Link key={item.href} href={item.href} className={cx('ds-nav-item', active && 'is-active')} aria-current={active ? 'page' : undefined}>
                      <Icon size={17} strokeWidth={1.9} />
                      {item.label}
                      {count > 0 && (
                        <span className={cx('ds-nav-count', item.hot && 'is-hot')} title={BADGE_LABELS[item.badge!](count)}>
                          {count > 99 ? '99+' : count}
                        </span>
                      )}
                    </Link>
                  );
                })}
              </div>
            );
          })}
        </nav>

        {isManager && <ReceptionLive onChange={refreshBadges} />}

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
