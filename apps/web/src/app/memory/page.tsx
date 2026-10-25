'use client';

import { useCallback, useEffect, useState } from 'react';
import { Archive, ArchiveRestore, Check, Pencil, Pin, PinOff, Plus, Trash2, X } from 'lucide-react';
import type { CreateMemoryInput, MemoryItemView, MemoryKind, UpdateMemoryInput } from '@ai-task-system/shared-types';
import { MANAGER_ROLES, MEMORY_KIND_LABELS, MEMORY_TEXT_MAX } from '@ai-task-system/shared-types';
import { api, ApiError } from '@/lib/api';
import { Protected } from '@/components/protected';
import { Alert, Badge, Button, Card, EmptyState, IconButton, Input, PageHeader, SearchInput, SegmentedControl, Select, Skeleton, Textarea } from '@/components/ui';

// «Память» (ARMS, фаза 1): что ассистент помнит о руководителе. Пункты
// попадают сюда из чата («запомни…»), вручную или из предложений ИИ (раз в
// сутки, только после «Принять»).

const KINDS = Object.keys(MEMORY_KIND_LABELS) as MemoryKind[];
const SOURCE_HINT: Record<MemoryItemView['source'], string> = {
  EXPLICIT: 'из чата',
  MANUAL: 'добавлено вручную',
  SUGGESTED: 'предложено ИИ',
};

function errorText(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

function MemoryRow({ item, onChange, onDelete }: { item: MemoryItemView; onChange: (patch: UpdateMemoryInput) => Promise<void>; onDelete: () => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(item.text);
  const [details, setDetails] = useState(item.details ?? '');
  const [busy, setBusy] = useState(false);
  const archived = item.status === 'ARCHIVED';

  async function run(action: () => Promise<void>) {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <li className="memory-row is-editing">
        <Textarea value={text} onChange={(e) => setText(e.target.value)} maxLength={MEMORY_TEXT_MAX} rows={2} aria-label="Текст пункта" />
        <Textarea value={details} onChange={(e) => setDetails(e.target.value)} rows={2} placeholder="Подробности — необязательно" aria-label="Подробности" />
        <div className="memory-row-actions">
          <Button
            size="sm"
            variant="primary"
            icon={Check}
            disabled={busy || text.trim().length < 2}
            onClick={() => run(async () => {
              await onChange({ text, details: details.trim() || null });
              setEditing(false);
            })}
          >
            Сохранить
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
            Отмена
          </Button>
        </div>
      </li>
    );
  }

  return (
    <li className={archived ? 'memory-row is-archived' : 'memory-row'}>
      <div className="memory-row-main">
        <span className="memory-row-text">
          {item.pinned && <Pin size={14} strokeWidth={2} className="memory-pin" aria-label="Закреплено" />}
          {item.text}
        </span>
        {item.details && <span className="ds-field-hint memory-row-details">{item.details}</span>}
        <span className="ds-field-hint">
          {SOURCE_HINT[item.source]} · {new Date(item.createdAt).toLocaleDateString('ru-RU')}
          {item.useCount > 0 && ` · использовано ${item.useCount}`}
        </span>
      </div>
      <div className="memory-row-actions">
        {archived ? (
          <IconButton icon={ArchiveRestore} label="Вернуть в память" size="sm" disabled={busy} onClick={() => run(() => onChange({ status: 'ACTIVE' }))} />
        ) : (
          <>
            <IconButton icon={Pencil} label="Изменить" size="sm" disabled={busy} onClick={() => setEditing(true)} />
            <IconButton icon={item.pinned ? PinOff : Pin} label={item.pinned ? 'Открепить' : 'Закрепить'} size="sm" disabled={busy} onClick={() => run(() => onChange({ pinned: !item.pinned }))} />
            <IconButton icon={Archive} label="В архив" size="sm" disabled={busy} onClick={() => run(() => onChange({ status: 'ARCHIVED' }))} />
          </>
        )}
        <IconButton
          icon={Trash2}
          label="Удалить"
          size="sm"
          disabled={busy}
          onClick={() => {
            if (window.confirm(`Удалить «${item.text}» из памяти навсегда?`)) void run(onDelete);
          }}
        />
      </div>
    </li>
  );
}

function AddForm({ onAdd, onCancel }: { onAdd: (input: CreateMemoryInput) => Promise<void>; onCancel: () => void }) {
  const [kind, setKind] = useState<MemoryKind>('PREFERENCE');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="memory-add"
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        onAdd({ kind, text }).finally(() => setBusy(false));
      }}
    >
      <Select value={kind} onChange={(e) => setKind(e.target.value as MemoryKind)} options={KINDS.map((k) => ({ value: k, label: MEMORY_KIND_LABELS[k] }))} aria-label="Вид" />
      <Input value={text} onChange={(e) => setText(e.target.value)} maxLength={MEMORY_TEXT_MAX} placeholder="Например: отчёты присылать в xlsx, не в pdf" aria-label="Что запомнить" autoFocus />
      <Button type="submit" variant="primary" disabled={busy || text.trim().length < 2} loading={busy}>
        Запомнить
      </Button>
      <IconButton icon={X} label="Отмена" onClick={onCancel} />
    </form>
  );
}

function MemoryPage() {
  const [items, setItems] = useState<MemoryItemView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<'ACTIVE' | 'ARCHIVED'>('ACTIVE');
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState(false);

  const load = useCallback(() => {
    api
      .get<MemoryItemView[]>('/memory')
      .then((list) => {
        setItems(list);
        setError(null);
      })
      .catch((err) => setError(errorText(err, 'Не удалось загрузить память')));
  }, []);

  useEffect(load, [load]);

  function replace(updated: MemoryItemView) {
    setItems((prev) => prev?.map((i) => (i.id === updated.id ? updated : i)) ?? prev);
  }

  async function patch(id: string, body: UpdateMemoryInput) {
    try {
      replace(await api.patch<MemoryItemView>(`/memory/${id}`, body));
    } catch (err) {
      setError(errorText(err, 'Не удалось сохранить'));
    }
  }

  async function remove(id: string) {
    try {
      await api.delete(`/memory/${id}`);
      setItems((prev) => prev?.filter((i) => i.id !== id) ?? prev);
    } catch (err) {
      setError(errorText(err, 'Не удалось удалить'));
    }
  }

  async function decide(id: string, accept: boolean) {
    try {
      replace(await api.post<MemoryItemView>(`/memory/${id}/${accept ? 'accept' : 'dismiss'}`));
    } catch (err) {
      setError(errorText(err, 'Не удалось сохранить решение'));
    }
  }

  async function add(input: CreateMemoryInput) {
    try {
      const created = await api.post<MemoryItemView>('/memory', input);
      setItems((prev) => [created, ...(prev ?? [])]);
      setAdding(false);
    } catch (err) {
      setError(errorText(err, 'Не удалось добавить'));
    }
  }

  const q = query.trim().toLowerCase();
  const pending = items?.filter((i) => i.status === 'PENDING') ?? [];
  const shown = (items ?? []).filter((i) => i.status === view && (!q || i.text.toLowerCase().includes(q) || i.details?.toLowerCase().includes(q)));
  const activeCount = items?.filter((i) => i.status === 'ACTIVE').length ?? 0;

  return (
    <div className="memory-page">
      <PageHeader
        title="Память"
        description="Что ассистент помнит о вас — учитывается в каждом ответе. Скажите в чате «запомни…» или добавьте здесь."
        actions={
          !adding && (
            <Button variant="primary" icon={Plus} onClick={() => setAdding(true)}>
              Добавить
            </Button>
          )
        }
      />

      {error && <Alert tone="danger">{error}</Alert>}

      {adding && (
        <Card>
          <AddForm onAdd={add} onCancel={() => setAdding(false)} />
        </Card>
      )}

      {pending.length > 0 && (
        <Card tone="agent" title="Предложено ИИ" subtitle="По вашей переписке с ассистентом. В память попадёт только принятое.">
          <ul className="memory-list">
            {pending.map((p) => (
              <li key={p.id} className="memory-row">
                <div className="memory-row-main">
                  <span className="memory-row-text">{p.text}</span>
                  <span className="ds-field-hint">{MEMORY_KIND_LABELS[p.kind]}</span>
                </div>
                <div className="memory-row-actions">
                  <Button size="sm" variant="primary" icon={Check} onClick={() => void decide(p.id, true)}>
                    Принять
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void decide(p.id, false)}>
                    Отклонить
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="memory-toolbar">
        <SegmentedControl
          label="Показать"
          value={view}
          onChange={(v) => setView(v as 'ACTIVE' | 'ARCHIVED')}
          options={[
            { value: 'ACTIVE', label: `В памяти${items ? ` · ${activeCount}` : ''}` },
            { value: 'ARCHIVED', label: 'Архив' },
          ]}
        />
        <SearchInput value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Поиск по памяти" aria-label="Поиск по памяти" />
      </div>

      {!items && !error && <Skeleton height={160} />}
      {items && shown.length === 0 && (
        <EmptyState
          title={q ? 'Ничего не найдено' : view === 'ACTIVE' ? 'Память пуста' : 'Архив пуст'}
          description={view === 'ACTIVE' && !q ? 'Скажите ассистенту «запомни, что отчёты мне нужны в xlsx» — пункт появится здесь.' : undefined}
        />
      )}
      {KINDS.map((kind) => {
        const group = shown.filter((i) => i.kind === kind);
        if (group.length === 0) return null;
        return (
          <Card key={kind} title={MEMORY_KIND_LABELS[kind]} actions={<Badge tone="neutral">{group.length}</Badge>}>
            <ul className="memory-list">
              {group.map((item) => (
                <MemoryRow key={item.id} item={item} onChange={(body) => patch(item.id, body)} onDelete={() => remove(item.id)} />
              ))}
            </ul>
          </Card>
        );
      })}
    </div>
  );
}

export default function Page() {
  return (
    <Protected requireRole={MANAGER_ROLES}>
      <MemoryPage />
    </Protected>
  );
}
