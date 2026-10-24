'use client';

import { ArrowDownToLine, CheckCheck, DoorOpen, Handshake, Reply, Undo2, type LucideIcon } from 'lucide-react';
import type { ReceptionRequestItem } from '@ai-task-system/shared-types';
import { ApiError } from '@/lib/api';
import { cx } from '@/components/ui';
import type { SheetMode } from './reception-sheet';

// Четыре действия руководителя сеткой 2×2 (редизайн M4, §4.5). Для
// ожидающего: «Заходите», «Ответить», «Разберитесь сами», «В конец очереди».
// Для уже вызванного — «Завершить приём» вместо «Заходите» и «Вернуть в
// очередь» вместо «В конец» (переходы те же, что в web reception-board).

export type QuickAction = 'call' | 'move-to-end' | 'return-to-queue';

// Очередь поменялась у кого-то ещё (другая вкладка, web, ассистент) —
// версия устарела или переход уже невозможен. Экран обновляет доску.
export function isQueueChanged(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409 && /^(VERSION_CONFLICT|INVALID_TRANSITION)/.test(err.message);
}

interface ActionDef {
  key: string;
  label: string;
  icon: LucideIcon;
  accent?: boolean;
  run: () => void;
  disabled?: boolean;
  hint?: string;
}

export function ReceptionActions({
  item,
  otherCalled,
  busy,
  onQuick,
  onSheet,
}: {
  item: ReceptionRequestItem;
  // Уже вызван кто-то другой — второго не позвать (RECEPTION_BUSY на сервере).
  otherCalled: boolean;
  busy: boolean;
  onQuick: (action: QuickAction) => void;
  onSheet: (mode: SheetMode) => void;
}) {
  const called = item.status === 'CALLED';
  const actions: ActionDef[] = called
    ? [
        { key: 'complete', label: 'Завершить приём', icon: CheckCheck, accent: true, run: () => onSheet('complete') },
        { key: 'answer', label: 'Ответить', icon: Reply, run: () => onSheet('answer') },
        { key: 'delegate', label: 'Разберитесь сами', icon: Handshake, run: () => onSheet('delegate') },
        { key: 'return', label: 'Вернуть в очередь', icon: Undo2, run: () => onQuick('return-to-queue') },
      ]
    : [
        {
          key: 'call',
          label: 'Заходите',
          icon: DoorOpen,
          accent: true,
          run: () => onQuick('call'),
          disabled: otherCalled,
          hint: otherCalled ? 'Сначала завершите текущий приём' : undefined,
        },
        { key: 'answer', label: 'Ответить', icon: Reply, run: () => onSheet('answer') },
        { key: 'delegate', label: 'Разберитесь сами', icon: Handshake, run: () => onSheet('delegate') },
        { key: 'end', label: 'В конец очереди', icon: ArrowDownToLine, run: () => onQuick('move-to-end') },
      ];

  return (
    <div className="rcp-actions">
      {actions.map((a) => (
        <button
          key={a.key}
          type="button"
          className={cx('rcp-action', a.accent && 'is-accent')}
          onClick={a.run}
          disabled={busy || a.disabled}
          title={a.hint}
        >
          <a.icon size={20} strokeWidth={1.9} />
          <span>{a.label}</span>
        </button>
      ))}
    </div>
  );
}
