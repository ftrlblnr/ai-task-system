'use client';

import { useState } from 'react';
import { ChevronRight, Plane } from 'lucide-react';
import { isManagerRole } from '@ai-task-system/shared-types';
import { useAuth } from '@/lib/auth-context';
import { ScreenHeader, SectionLabel } from '@/components/ui';
import { useOpenSection } from './app-shell';
import { Avatar } from './avatar';
import { ProfileOverlay } from './profile-overlay';

// «Сегодня» — стартовый раздел (редизайн §4.2). На M1 — только каркас:
// заголовок с датой, профиль и «Разделы → Поездки» для руководителя (в его
// нижней панели Поездок нет). Сводка дня — встреча, счётчики, «Требует
// вас» — появится на M2.

// Дата — по времени компании (Казахстан), а не устройства: руководитель в
// поездке видит тот же «сегодня», что и сервер со сроками задач.
const kickerFormat = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Asia/Almaty', weekday: 'long', day: 'numeric', month: 'long' });

export function TodayScreen() {
  const { user } = useAuth();
  const openSection = useOpenSection();
  const [profileOpen, setProfileOpen] = useState(false);
  const manager = user ? isManagerRole(user.role) : false;

  return (
    <div>
      <ScreenHeader
        kicker={kickerFormat.format(new Date())}
        title="Сегодня"
        action={
          user && (
            <button type="button" className="screen-header-avatar" onClick={() => setProfileOpen(true)} aria-label="Профиль">
              <Avatar id={user.id} name={user.fullName} size={40} />
            </button>
          )
        }
      />
      {profileOpen && <ProfileOverlay onClose={() => setProfileOpen(false)} />}

      {manager && (
        <>
          <SectionLabel>Разделы</SectionLabel>
          <div className="list-card">
            <button type="button" className="list-row" onClick={() => openSection('trips')}>
              <span className="list-row-icon">
                <Plane size={18} strokeWidth={1.75} />
              </span>
              <span className="list-row-label">Поездки</span>
              <ChevronRight size={18} className="list-row-chevron" />
            </button>
          </div>
        </>
      )}
    </div>
  );
}
