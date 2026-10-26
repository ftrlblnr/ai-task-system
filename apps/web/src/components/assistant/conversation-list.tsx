'use client';

import { useState } from 'react';
import { Check, Pencil, Plus, X } from 'lucide-react';
import type { ConversationSummary } from '@ai-task-system/shared-types';
import { api, ApiError } from '@/lib/api';
import { Alert, Button, IconButton } from '@/components/ui';

// Список разговоров слева на /assistant: выбор, новый разговор,
// переименование. Вынесено из app/assistant/page.tsx (W0) без изменения
// поведения.

export function conversationTitle(c: ConversationSummary): string {
  return c.title?.trim() || 'Новый разговор';
}

export function useConversations() {
  const [conversations, setConversations] = useState<ConversationSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Первая загрузка — возвращает список (null при ошибке), выбор разговора
  // остаётся за страницей.
  async function load(): Promise<ConversationSummary[] | null> {
    try {
      const list = await api.get<ConversationSummary[]>('/assistant/conversations');
      setConversations(list);
      setError(null);
      return list;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось загрузить список разговоров');
      return null;
    }
  }

  // После первого ответа в разговоре сервер сам выводит его заголовок из
  // первой реплики — обновляем только список слева (заголовок мог
  // смениться), НЕ трогаем переписку: она уже корректно обновлена самим
  // стримом (message.completed), повторная загрузка означала бы лишний
  // "мигающий" Loading прямо после ответа.
  function refreshTitles() {
    api
      .get<ConversationSummary[]>('/assistant/conversations')
      .then(setConversations)
      .catch(() => undefined);
  }

  async function create(): Promise<ConversationSummary | null> {
    try {
      const created = await api.post<ConversationSummary>('/assistant/conversations', {});
      setConversations((prev) => [created, ...(prev ?? [])]);
      return created;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось создать разговор');
      return null;
    }
  }

  async function rename(id: string, title: string) {
    try {
      const updated = await api.patch<ConversationSummary>(`/assistant/conversations/${id}`, { title });
      setConversations((prev) => (prev ?? []).map((c) => (c.id === id ? updated : c)));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось переименовать разговор');
    }
  }

  return { conversations, error, load, refreshTitles, create, rename };
}

interface Props {
  conversations: ConversationSummary[] | null;
  error: string | null;
  activeId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onRename: (id: string, title: string) => void;
}

export function ConversationList({ conversations, error, activeId, onSelect, onCreate, onRename }: Props) {
  // Переименование разговора (владелец 05.10.2026) — инлайн-редактирование
  // прямо в списке, без отдельного диалога: editingId — какой элемент
  // сейчас в режиме правки, editingTitle — его черновой текст.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');

  function startEditing(c: ConversationSummary) {
    setEditingId(c.id);
    setEditingTitle(conversationTitle(c));
  }

  function cancelEditing() {
    setEditingId(null);
    setEditingTitle('');
  }

  function save(id: string) {
    const title = editingTitle.trim();
    setEditingId(null);
    if (title) onRename(id, title);
  }

  return (
    <aside className="assistant-conversations-sidebar">
      <Button variant="secondary" icon={Plus} onClick={onCreate}>
        Новый разговор
      </Button>
      {error && <Alert tone="danger">{error}</Alert>}
      {!conversations ? (
        <p className="ds-field-hint">Загрузка…</p>
      ) : (
        <div className="assistant-conversation-list">
          {conversations.map((c) =>
            editingId === c.id ? (
              <div key={c.id} style={{ display: 'flex', gap: 4, alignItems: 'center', padding: '2px 0' }}>
                <input
                  autoFocus
                  value={editingTitle}
                  onChange={(e) => setEditingTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') save(c.id);
                    if (e.key === 'Escape') cancelEditing();
                  }}
                  onBlur={() => save(c.id)}
                  maxLength={200}
                  aria-label="Название разговора"
                  className="ds-input"
                  style={{ flex: 1, minWidth: 0, height: 30, fontSize: '0.86rem', padding: '0 8px' }}
                />
                {/* onMouseDown+preventDefault — иначе клик по кнопке сначала роняет
                    фокус с input, onBlur выше уже сохраняет/отменяет раньше, чем
                    успевает сработать onClick самой кнопки. */}
                <IconButton icon={Check} label="Сохранить" size="sm" onMouseDown={(e) => e.preventDefault()} onClick={() => save(c.id)} />
                <IconButton icon={X} label="Отменить" size="sm" onMouseDown={(e) => e.preventDefault()} onClick={cancelEditing} />
              </div>
            ) : (
              <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                <button
                  type="button"
                  className={`assistant-conversation-item ${c.id === activeId ? 'active' : ''}`}
                  onClick={() => onSelect(c.id)}
                  style={{ flex: 1, minWidth: 0 }}
                >
                  {conversationTitle(c)}
                </button>
                <IconButton icon={Pencil} label="Переименовать" size="sm" onClick={() => startEditing(c)} />
              </div>
            ),
          )}
          {conversations.length === 0 && <p className="ds-field-hint">Разговоров пока нет</p>}
        </div>
      )}
    </aside>
  );
}
