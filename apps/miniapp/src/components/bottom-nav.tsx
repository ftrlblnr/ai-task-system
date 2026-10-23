'use client';

import type { AppSection, SectionKey } from './app-shell';

// Нижняя панель (редизайн M1): пять пунктов, ассистент — центральная
// приподнятая кнопка с микрофоном на акценте.
export function BottomNav({ items, current, onOpen }: { items: AppSection[]; current: SectionKey; onOpen: (key: SectionKey) => void }) {
  return (
    <nav className="bottom-nav" aria-label="Разделы">
      {items.map(({ key, label, icon: Icon }) =>
        key === 'assistant' ? (
          <div key={key} className="bottom-nav-center">
            <button
              type="button"
              className={current === key ? 'bottom-nav-mic is-active' : 'bottom-nav-mic'}
              aria-label={label}
              aria-current={current === key ? 'page' : undefined}
              onClick={() => onOpen(key)}
            >
              <Icon size={26} strokeWidth={2} />
            </button>
          </div>
        ) : (
          <button
            key={key}
            type="button"
            className={current === key ? 'bottom-nav-item is-active' : 'bottom-nav-item'}
            aria-current={current === key ? 'page' : undefined}
            onClick={() => onOpen(key)}
          >
            <Icon size={22} strokeWidth={current === key ? 2.25 : 1.75} />
            {label}
          </button>
        ),
      )}
    </nav>
  );
}
