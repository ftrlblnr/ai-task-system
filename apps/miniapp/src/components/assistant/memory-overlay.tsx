'use client';

import { useEffect, useState } from 'react';
import { ArrowLeft, Pin, Trash2 } from 'lucide-react';
import type { MemoryItemView, MemoryKind } from '@ai-task-system/shared-types';
import { MEMORY_KIND_LABELS } from '@ai-task-system/shared-types';
import { api } from '@/lib/api';
import { notificationHaptic, useBackButton } from '@/lib/telegram';
import { Alert, IconButton, SectionLabel } from '@/components/ui';
import { OverlayPortal } from '../overlay-portal';

// Память ассистента в Mini App (ARMS, фаза 1) — пока только просмотр и
// удаление; правка и предложения ИИ — на странице «Память» в веб-версии.

const KINDS = Object.keys(MEMORY_KIND_LABELS) as MemoryKind[];

export function useMemoryCount(enabled: boolean, active: boolean): [number | null, () => void] {
  const [count, setCount] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!enabled || !active) return;
    let cancelled = false;
    api
      .get<MemoryItemView[]>('/memory?status=ACTIVE')
      .then((items) => !cancelled && setCount(items.length))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [enabled, active, tick]);
  return [count, () => setTick((t) => t + 1)];
}

export function memoryCountLabel(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  const word = mod10 === 1 && mod100 !== 11 ? 'пункт' : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? 'пункта' : 'пунктов';
  return `Память: ${count} ${word}`;
}

export function MemoryOverlay({ onClose }: { onClose: () => void }) {
  const [items, setItems] = useState<MemoryItemView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const nativeBack = useBackButton(onClose);

  useEffect(() => {
    api
      .get<MemoryItemView[]>('/memory?status=ACTIVE')
      .then(setItems)
      .catch(() => setError('Не удалось загрузить память'));
  }, []);

  async function remove(item: MemoryItemView) {
    if (!window.confirm(`Удалить из памяти «${item.text}»?`)) return;
    try {
      await api.delete(`/memory/${item.id}`);
      setItems((prev) => prev?.filter((i) => i.id !== item.id) ?? prev);
      notificationHaptic('success');
    } catch {
      notificationHaptic('error');
      setError('Не удалось удалить');
    }
  }

  return (
    <OverlayPortal>
      <div className="overlay">
        <div className="overlay-header">
          {!nativeBack && (
            <button className="back-btn" onClick={onClose} aria-label="Назад">
              <ArrowLeft size={17} strokeWidth={2.25} />
            </button>
          )}
          <strong>Память ассистента</strong>
        </div>
        <div className="overlay-body memory-overlay">
          {error && <Alert tone="danger">{error}</Alert>}
          {!items && !error && <p className="ds-field-hint">Загрузка…</p>}
          {items && items.length === 0 && (
            <p className="ds-field-hint">Пока пусто. Скажите ассистенту «запомни, что…» — пункт появится здесь.</p>
          )}
          {KINDS.map((kind) => {
            const group = items?.filter((i) => i.kind === kind) ?? [];
            if (group.length === 0) return null;
            return (
              <section key={kind}>
                <SectionLabel>{MEMORY_KIND_LABELS[kind]}</SectionLabel>
                <div className="list-card">
                  {group.map((item) => (
                    <div key={item.id} className="memory-row">
                      <span className="memory-row-text">
                        {item.pinned && <Pin size={13} strokeWidth={2} className="memory-pin" aria-label="Закреплено" />}
                        {item.text}
                      </span>
                      <IconButton icon={Trash2} label="Удалить" size="sm" onClick={() => void remove(item)} />
                    </div>
                  ))}
                </div>
              </section>
            );
          })}
          {items && items.length > 0 && <p className="ds-field-hint">Править и добавлять пункты — на странице «Память» в веб-версии.</p>}
        </div>
      </div>
    </OverlayPortal>
  );
}
