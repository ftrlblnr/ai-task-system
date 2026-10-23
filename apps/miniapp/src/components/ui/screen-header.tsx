import type { ReactNode } from 'react';

// Заголовок раздела (редизайн M1): надзаголовок моноширинным капсом, h1 и
// слот справа (кнопка «+», профиль, бейдж состояния).
export function ScreenHeader({ kicker, title, action }: { kicker?: ReactNode; title: ReactNode; action?: ReactNode }) {
  return (
    <header className="screen-header">
      <div className="screen-header-text">
        {kicker && <span className="kicker">{kicker}</span>}
        <h1>{title}</h1>
      </div>
      {action}
    </header>
  );
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return <h2 className="section-label">{children}</h2>;
}
