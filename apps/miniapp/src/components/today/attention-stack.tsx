'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';
import { companyDayKey } from '@/lib/company-time';
import { loadPref, savePref } from '@/lib/telegram';
import { Button } from '@/components/ui';

// «Требует вас» (§4.2 п.3): стопка — верхняя карточка и две подложки под
// ней, счётчик «N из M». «← Позже» прячет карточку до завтра только у себя
// (без запроса к API): один ключ с датой внутри, а не ключ на каждый день —
// у CloudStorage лимит на число ключей, старые дни не копятся.

export interface AttentionItem {
  key: string;
  kicker: ReactNode;
  title: string;
  text?: string | null;
  action: { label: string; onClick: () => void; disabled?: boolean; hint?: string; busy?: boolean };
}

const LATER_KEY = 'today_later';

export function AttentionStack({ items }: { items: AttentionItem[] | null }) {
  const [later, setLater] = useState<string[]>([]);

  useEffect(() => {
    void loadPref(LATER_KEY).then((raw) => {
      if (!raw) return;
      try {
        const saved = JSON.parse(raw) as { day?: string; keys?: string[] };
        if (saved.day === companyDayKey(new Date()) && Array.isArray(saved.keys)) setLater(saved.keys);
      } catch {
        // Битое значение — просто начинаем день заново.
      }
    });
  }, []);

  function postpone(key: string) {
    const next = [...later, key];
    setLater(next);
    savePref(LATER_KEY, JSON.stringify({ day: companyDayKey(new Date()), keys: next }));
  }

  if (!items) return <div className="attention-card attention-skeleton" aria-hidden />;

  const visible = items.filter((i) => !later.includes(i.key));
  if (visible.length === 0) {
    return <div className="attention-empty">Всё разобрано</div>;
  }

  const top = visible[0];
  // Счётчик — сколько уже разобрано за сегодня, а не только оставшееся:
  // так видно движение к концу стопки.
  const position = items.length - visible.length + 1;

  return (
    <div className="attention-stack" data-depth={Math.min(visible.length, 3)}>
      <article className="attention-card">
        <div className="attention-head">
          <span className="kicker">{top.kicker}</span>
          <span className="attention-count">
            {position} из {items.length}
          </span>
        </div>
        <h3 className="attention-title">{top.title}</h3>
        {top.text && <p className="attention-text">{top.text}</p>}
        <div className="attention-actions">
          <Button variant="ghost" size="lg" icon={ArrowLeft} onClick={() => postpone(top.key)}>
            Позже
          </Button>
          <Button
            variant="primary"
            size="lg"
            className="attention-primary"
            onClick={top.action.onClick}
            disabled={top.action.disabled}
            loading={top.action.busy}
            title={top.action.hint}
          >
            {top.action.label}
          </Button>
        </div>
      </article>
    </div>
  );
}
