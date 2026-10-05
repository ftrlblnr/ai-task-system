'use client';

import { useState, type FormEvent, type KeyboardEvent } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowUp, Sparkles } from 'lucide-react';
import { AgentOrb } from '@/components/ui/agent-orb';

// «Стол руководителя» (ТЗ v1.0, 05.10.2026, разделы 6.1–6.2). Описание —
// РОВНО "Задайте вопрос по рабочим данным." без упоминания голоса: на этой
// странице нет микрофона, обещать голосовой ввод здесь нельзя (раздел 6.1
// явно запрещает), хотя референс-скриншот ошибочно показывает такую фразу
// — текст ТЗ приоритетнее демонстрации (раздел 2 ТЗ).
const QUICK_PROMPTS = ['Покажи просроченные задачи', 'Какие встречи впереди?'];

export const ASSISTANT_DRAFT_KEY = 'adjutant:assistant-draft';

function handoffToAssistant(router: ReturnType<typeof useRouter>, text: string) {
  const value = text.trim();
  if (!value) return;
  // Черновик — через sessionStorage с одноразовым чтением (раздел 6.2 ТЗ:
  // НЕ в URL/аналитику), не сам запрос к модели — страница ассистента сама
  // решает, отправлять ли и когда.
  sessionStorage.setItem(ASSISTANT_DRAFT_KEY, JSON.stringify({ text: value }));
  router.push('/assistant');
}

export function AgentHero() {
  const router = useRouter();
  const [value, setValue] = useState('');

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    handoffToAssistant(router, value);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      handoffToAssistant(router, value);
    }
  }

  return (
    <section
      style={{
        background: 'var(--agent-hero-bg)',
        color: 'var(--on-agent)',
        borderRadius: 20,
        padding: '28px 32px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 24,
        flexWrap: 'wrap',
      }}
    >
      <div style={{ flex: '1 1 360px', minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--agent)', marginBottom: 12 }}>
          <Sparkles size={13} strokeWidth={1.75} />
          Адъютант / AI-агент
        </div>
        {/* h2, не h1 — заголовок страницы (раздел 1 ТЗ: "Стол руководителя")
            уже задан один раз в dashboard-page.tsx; второй h1 на странице
            нарушает семантику заголовков (раздел 12 ТЗ). */}
        <h2 style={{ margin: '0 0 10px', fontSize: 28, lineHeight: '34px', fontWeight: 650, letterSpacing: '-0.02em', color: 'var(--on-agent)' }}>
          Освободите внимание для важных решений.
        </h2>
        <p style={{ margin: '0 0 16px', fontSize: 14, lineHeight: '20px', color: 'rgba(255,255,255,0.7)' }}>Задайте вопрос по рабочим данным.</p>

        <form onSubmit={onSubmit} style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Что требует моего внимания?"
            aria-label="Вопрос ассистенту"
            maxLength={4000}
            style={{
              flex: 1,
              minWidth: 0,
              height: 40,
              borderRadius: 10,
              border: '1px solid rgba(255,255,255,0.18)',
              background: 'rgba(255,255,255,0.08)',
              color: 'var(--on-agent)',
              padding: '0 14px',
              fontSize: 15,
            }}
          />
          <button
            type="submit"
            aria-label="Открыть вопрос в ассистенте"
            disabled={!value.trim()}
            style={{
              width: 40,
              height: 40,
              flex: 'none',
              borderRadius: 10,
              border: 0,
              background: 'var(--agent)',
              color: 'var(--on-agent)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: value.trim() ? 'pointer' : 'default',
              opacity: value.trim() ? 1 : 0.5,
            }}
          >
            <ArrowUp size={18} strokeWidth={2} />
          </button>
        </form>

        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
          {QUICK_PROMPTS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => handoffToAssistant(router, p)}
              style={{ background: 'none', border: 0, padding: 0, color: 'rgba(255,255,255,0.75)', fontSize: 13, cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: 3 }}
            >
              {p} ↗
            </button>
          ))}
        </div>
      </div>

      <AgentOrb size="large" state="idle" className="dashboard-hero-orb" />
    </section>
  );
}
