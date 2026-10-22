'use client';

import { ArrowLeft } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { OverlayPortal } from './overlay-portal';
import { AvatarEditor } from './avatar-editor';

// Профиль в Mini App (владелец 22.10.2026) — пока только своё фото;
// открывается тапом по своему аватару в шапке «Задач».
export function ProfileOverlay({ onClose }: { onClose: () => void }) {
  const { user } = useAuth();
  if (!user) return null;
  return (
    <OverlayPortal>
      <div className="overlay">
        <div className="overlay-header">
          <button className="back-btn" onClick={onClose} aria-label="Назад">
            <ArrowLeft size={17} strokeWidth={2.25} />
          </button>
          <strong>Профиль</strong>
        </div>
        <div className="overlay-body" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div>
            <h2 style={{ margin: 0 }}>{user.fullName}</h2>
          </div>
          <AvatarEditor employeeId={user.id} name={user.fullName} size={96} />
        </div>
      </div>
    </OverlayPortal>
  );
}
