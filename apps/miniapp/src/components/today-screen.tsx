'use client';

import { useState } from 'react';
import { ChevronRight, Mail, Plane } from 'lucide-react';
import { isManagerRole } from '@ai-task-system/shared-types';
import { useAuth } from '@/lib/auth-context';
import { companyKicker } from '@/lib/company-time';
import { ScreenHeader, SectionLabel } from '@/components/ui';
import { useOpenSection } from './app-shell';
import { Avatar } from './avatar';
import { ProfileOverlay } from './profile-overlay';
import { OwnerToday } from './today/owner-today';
import { EmployeeToday } from './today/employee-today';

// «Сегодня» — стартовый раздел (редизайн §4.2, M2). Вариант руководителя
// строится на GET /dashboard/overview, а он закрыт @Roles(OWNER) — поэтому
// ADMIN пока видит вариант сотрудника (решение владельца, не менять без него).
export function TodayScreen({ active = true }: { active?: boolean }) {
  const { user } = useAuth();
  const openSection = useOpenSection();
  const [profileOpen, setProfileOpen] = useState(false);
  if (!user) return null;
  const manager = isManagerRole(user.role);

  return (
    <div>
      <ScreenHeader
        kicker={companyKicker(new Date())}
        title="Сегодня"
        action={
          <button type="button" className="screen-header-avatar" onClick={() => setProfileOpen(true)} aria-label="Профиль">
            <Avatar id={user.id} name={user.fullName} size={40} />
          </button>
        }
      />
      {profileOpen && <ProfileOverlay onClose={() => setProfileOpen(false)} />}

      {user.role === 'OWNER' ? <OwnerToday active={active} /> : <EmployeeToday active={active} userId={user.id} />}

      {/* У руководителя Почты и Поездок нет в нижней панели — пятое место занял Календарь. */}
      {manager && (
        <>
          <SectionLabel>Разделы</SectionLabel>
          <div className="list-card">
            <button type="button" className="list-row" onClick={() => openSection('mail')}>
              <span className="list-row-icon">
                <Mail size={18} strokeWidth={1.75} />
              </span>
              <span className="list-row-label">Почта</span>
              <ChevronRight size={18} className="list-row-chevron" />
            </button>
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
