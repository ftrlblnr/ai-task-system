import type { ReactNode } from 'react';
import { cx } from './button';

// Вкладки раздела — подчёркнутые, под шапкой страницы (редизайн web W4,
// общие с W6). SegmentedControl остаётся для переключателей внутри
// раздела (вид, ящик, фильтр).

export interface PageTab<T extends string> {
  value: T;
  label: string;
  // Счётчик рядом с названием (ожидающие изменения и т.п.), 0 — не показываем.
  count?: number;
}

interface PageTabsProps<T extends string> {
  tabs: PageTab<T>[];
  value: T;
  onChange: (value: T) => void;
  label: string;
  aside?: ReactNode;
}

export function PageTabs<T extends string>({ tabs, value, onChange, label, aside }: PageTabsProps<T>) {
  return (
    <div className="page-tabs" role="tablist" aria-label={label}>
      {tabs.map((t) => (
        <button key={t.value} type="button" role="tab" aria-selected={value === t.value} className={cx('page-tab', value === t.value && 'is-active')} onClick={() => onChange(t.value)}>
          {t.label}
          {t.count ? <span className="ds-nav-count">{t.count}</span> : null}
        </button>
      ))}
      {aside && <span className="page-tabs-aside">{aside}</span>}
    </div>
  );
}
