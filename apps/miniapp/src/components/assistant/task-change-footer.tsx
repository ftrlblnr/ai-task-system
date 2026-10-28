'use client';

import { useEffect, useState } from 'react';
import type { TaskCardData, VoiceUndoResponse } from '@ai-task-system/shared-types';
import { api, ApiError } from '@/lib/api';
import { requestAssistantRefresh } from '@/lib/assistant-refresh';
import { notificationHaptic } from '@/lib/telegram';
import { Button } from '@/components/ui';

// Единый агент A2: под карточкой задачи, которую только что изменил
// ассистент, — что изменилось и «Отменить» на 30 секунд. Откат делает
// сервер по своему снимку (POST /voice/undo, тот же, что у голоса); клиент
// присылает только токен.

// Кнопка гаснет чуть раньше серверного срока — часы телефона и сервера
// расходятся.
const CLOCK_MARGIN_MS = 2_000;

function changeText(change: { from: string | null; to: string | null }): string {
  if (change.from && change.to) return `${change.from} → ${change.to}`;
  if (change.from) return `${change.from} → снято`;
  return change.to ?? '';
}

export function TaskChangeFooter({ data }: { data: TaskCardData }) {
  const deadline = data.undoToken && data.undoExpiresAt ? Date.parse(data.undoExpiresAt) - CLOCK_MARGIN_MS : 0;
  const [undoOpen, setUndoOpen] = useState(() => deadline > Date.now());
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!undoOpen) return;
    const timer = setTimeout(() => setUndoOpen(false), Math.max(0, deadline - Date.now()));
    return () => clearTimeout(timer);
  }, [undoOpen, deadline]);

  const changes = data.changes ?? [];
  if (changes.length === 0 && !undoOpen && state === 'idle' && !error) return null;

  async function undo() {
    if (!data.undoToken) return;
    setState('busy');
    setError(null);
    try {
      const response = await api.post<VoiceUndoResponse>('/voice/undo', { undoToken: data.undoToken });
      notificationHaptic(response.ok ? 'success' : 'error');
      if (response.ok) {
        setState('done');
        setUndoOpen(false);
      } else {
        setState('idle');
        setError(response.error ?? 'Не удалось отменить');
      }
      requestAssistantRefresh();
    } catch (err) {
      notificationHaptic('error');
      setState('idle');
      setError(err instanceof ApiError ? err.message : 'Не удалось отменить');
    }
  }

  return (
    <div className="task-change">
      {changes.length > 0 && (
        <ul className="task-change-list">
          {changes.map((c) => (
            <li key={c.label}>
              <span className="task-change-label">{c.label}:</span> {changeText(c)}
            </li>
          ))}
        </ul>
      )}
      {state === 'done' ? (
        <span className="ds-field-hint">Отменено</span>
      ) : (
        undoOpen && (
          <div className="voice-confirm-actions">
            <Button size="sm" variant="ghost" onClick={() => void undo()} disabled={state === 'busy'}>
              Отменить
            </Button>
          </div>
        )
      )}
      {error && <span className="ds-field-hint">{error}</span>}
    </div>
  );
}
