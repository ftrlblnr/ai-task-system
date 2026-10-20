'use client';

import { useCallback, useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import { useSearchParams } from 'next/navigation';
import { Mic, RefreshCw, Square } from 'lucide-react';
import type {
  AnswerReceptionRequestInput,
  CompleteReceptionRequestInput,
  DelegateReceptionRequestInput,
  ReceptionBoardView,
  ReceptionRequestItem,
  ReceptionRequestType,
  RejectReceptionRequestInput,
} from '@ai-task-system/shared-types';
import { api, ApiError } from '@/lib/api';
import { useIdempotencyKey } from '@/lib/use-idempotency-key';
import { useDictation } from '@/lib/use-dictation';
import { Alert, Badge, Button, Dialog, IconButton, SearchInput, Textarea, cx } from '@/components/ui';

// Доска приёмной руководителя (владелец 20.10.2026). Вопрос перетаскивают
// в нужный блок — «Заходите» вызывает сотрудника, на «Очередь» — в конец
// очереди, на «Разберитесь сами»/«Отвечено» открывается карточка с полем
// ответа. Или открыть карточку кликом и сделать всё оттуда, в том числе
// ответить текстом или голосом — ответ уходит сотруднику в Telegram, а
// вопрос — в «Отвечено».

const POLL_MS = 5_000;

const REQUEST_TYPE_LABELS: Record<ReceptionRequestType, string> = {
  DECISION: 'Решение',
  APPROVAL: 'Согласование',
  DISCUSSION: 'Обсуждение',
  HELP: 'Помощь',
};

type ColumnId = 'queue' | 'called' | 'delegated' | 'answered';
type Intent = 'answer' | 'delegate' | 'complete' | null;

const COLUMNS: { id: ColumnId; label: string; dot: string; empty: string }[] = [
  { id: 'queue', label: 'Очередь', dot: 'var(--ink-3)', empty: 'Ожидающих вопросов нет' },
  { id: 'called', label: 'Заходите', dot: 'var(--warn)', empty: 'Перетащите вопрос сюда, чтобы пригласить' },
  { id: 'delegated', label: 'Разберитесь сами', dot: 'var(--info)', empty: 'Перетащите сюда — сотрудник решит сам' },
  { id: 'answered', label: 'Отвечено', dot: 'var(--ok)', empty: 'Перетащите сюда, чтобы ответить' },
];

function formatDateTime(value: string | null): string {
  return value ? new Date(value).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
}

function isExpired(item: ReceptionRequestItem): boolean {
  return Boolean(item.desiredBy && new Date(item.desiredBy).getTime() < Date.now());
}

function matchesSearch(item: ReceptionRequestItem, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return item.title.toLowerCase().includes(q) || item.author.fullName.toLowerCase().includes(q);
}

// --- карточка на доске ---

function RequestCard({
  item,
  draggable,
  dragging,
  highlighted,
  onOpen,
  onDragStart,
  onDragEnd,
}: {
  item: ReceptionRequestItem;
  draggable: boolean;
  dragging: boolean;
  highlighted: boolean;
  onOpen: () => void;
  onDragStart: (e: DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
}) {
  const closed = item.status !== 'WAITING' && item.status !== 'CALLED';
  return (
    <article
      className={cx('ds-task', dragging && 'is-dragging')}
      style={{ cursor: draggable ? 'grab' : 'pointer', outline: highlighted ? '2px solid var(--agent)' : undefined }}
      tabIndex={0}
      role="button"
      draggable={draggable}
      onClick={onOpen}
      onKeyDown={(e: KeyboardEvent<HTMLElement>) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    >
      <div style={{ fontSize: 12, color: 'var(--ink-3)' }}>{item.author.fullName}</div>
      <h3 className="ds-task-title">{item.title}</h3>
      {closed ? (
        item.resolution && (
          <p
            style={{ margin: 0, fontSize: 13, lineHeight: '18px', color: 'var(--ink-2)', display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}
          >
            {item.resolution}
          </p>
        )
      ) : (
        <div className="ds-task-meta">
          <Badge>{REQUEST_TYPE_LABELS[item.requestType]}</Badge>
          {item.expectedMinutes && <Badge>~{item.expectedMinutes} мин</Badge>}
          {isExpired(item) && <Badge tone="warn">Истёк срок</Badge>}
          {item.author.status === 'INACTIVE' && <Badge>Неактивен</Badge>}
        </div>
      )}
      <div className="ds-task-foot">
        {closed ? (
          <>
            {item.status === 'COMPLETED' && 'Обсудили · '}
            {formatDateTime(item.closedAt)}
          </>
        ) : item.status === 'CALLED' ? (
          <>Вызван {formatDateTime(item.lastCalledAt)}</>
        ) : (
          <>
            Подано {formatDateTime(item.createdAt)}
            {item.desiredBy && <> · до {formatDateTime(item.desiredBy)}</>}
          </>
        )}
      </div>
    </article>
  );
}

// --- карточка вопроса: подробности, действия, ответ текстом/голосом ---

function RequestDialog({
  item,
  intent,
  hasOtherCalled,
  notificationStatus,
  onClose,
  onDone,
}: {
  item: ReceptionRequestItem;
  intent: Intent;
  hasOtherCalled: boolean;
  notificationStatus: string | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const idem = useIdempotencyKey();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dictation = useDictation('/reception/transcribe', (spoken) => {
    setText((prev) => (prev.trim() ? `${prev.trimEnd()} ${spoken}` : spoken));
    textareaRef.current?.focus();
  });

  const active = item.status === 'WAITING' || item.status === 'CALLED';
  const waiting = item.status === 'WAITING';
  const trimmed = text.trim();

  useEffect(() => {
    if (active && intent) textareaRef.current?.focus();
  }, [active, intent]);

  // Одна попытка = один ключ; повтор той же кнопки после сбоя переиспользует
  // его, следующее действие получает новый (тот же приём, что раньше).
  async function run(action: string, path: string, body: object) {
    setBusy(action);
    setError(null);
    try {
      await api.post(`/reception/requests/${item.id}/${path}`, body, { 'Idempotency-Key': idem.key() });
      idem.reset();
      onDone();
    } catch (err) {
      idem.reset();
      setError(err instanceof ApiError ? err.message : 'Не удалось выполнить действие');
      setBusy(null);
    }
  }

  const answer = () => run('answer', 'answer', { version: item.version, text: trimmed } satisfies AnswerReceptionRequestInput);
  const delegate = () => run('delegate', 'delegate', { version: item.version, comment: trimmed || undefined } satisfies DelegateReceptionRequestInput);
  const complete = () => run('complete', 'complete', { version: item.version, resolution: trimmed || undefined } satisfies CompleteReceptionRequestInput);
  const reject = () => run('reject', 'reject', { version: item.version, reason: trimmed || undefined } satisfies RejectReceptionRequestInput);
  const call = () => run('call', 'call', { version: item.version });
  const moveToEnd = () => run('moveToEnd', 'move-to-end', { version: item.version });
  const returnToQueue = () => run('returnToQueue', 'return-to-queue', { version: item.version });

  // Главная кнопка — по тому, куда перетащили карточку; по клику на
  // ожидающий вопрос — «Ответить», на вызванного — «Завершить приём».
  const primary = intent === 'delegate' ? 'delegate' : intent === 'answer' || (intent === null && waiting) ? 'answer' : 'complete';
  const placeholder =
    primary === 'answer'
      ? 'Ответ сотруднику — напишите или надиктуйте'
      : primary === 'delegate'
        ? 'Комментарий — необязательно'
        : 'Итог обсуждения — необязательно';

  const recording = dictation.phase === 'recording';
  const processing = dictation.phase === 'processing';
  const locked = Boolean(busy) || recording || processing;

  const meta = [
    REQUEST_TYPE_LABELS[item.requestType],
    item.expectedMinutes ? `~${item.expectedMinutes} мин` : null,
    `подано ${formatDateTime(item.createdAt)}`,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <Dialog title={item.title} description={`${item.author.fullName} · ${meta}`} onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{item.description}</p>

        {item.desiredBy && (
          <Alert tone={isExpired(item) ? 'warn' : 'info'}>
            Нужен ответ до {formatDateTime(item.desiredBy)}
            {item.urgencyReason && <> — {item.urgencyReason}</>}
          </Alert>
        )}

        {item.status === 'CALLED' && (
          <p className="ds-field-hint" style={{ margin: 0 }}>
            Вызван {formatDateTime(item.lastCalledAt)}
            {notificationStatus === 'SENT' && ' · уведомление доставлено'}
            {notificationStatus === 'PENDING' && ' · уведомление отправляется…'}
            {notificationStatus === 'FAILED' && ' · не удалось отправить уведомление'}
            {notificationStatus === 'SKIPPED' && ' · Telegram не привязан — сообщите сотруднику сами'}
          </p>
        )}

        {!active && item.resolution && (
          <div>
            <div className="ds-field-hint">
              {item.status === 'ANSWERED' ? 'Ответ' : item.status === 'DELEGATED' ? 'Комментарий' : item.status === 'COMPLETED' ? 'Итог' : 'Причина'}
            </div>
            <p style={{ margin: '4px 0 0', whiteSpace: 'pre-wrap' }}>{item.resolution}</p>
          </div>
        )}
        {!active && item.rejectionReason && <p style={{ margin: 0 }}>Причина отказа: {item.rejectionReason}</p>}

        {active && (
          <>
            <div style={{ position: 'relative' }}>
              <Textarea
                ref={textareaRef}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={processing ? 'Распознаю запись…' : placeholder}
                maxLength={3000}
                rows={4}
                disabled={processing}
                onKeyDown={(e) => {
                  // Ctrl/⌘+Enter — выполнить главное действие.
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !locked) {
                    e.preventDefault();
                    if (primary === 'answer' && trimmed) void answer();
                    if (primary === 'delegate') void delegate();
                    if (primary === 'complete') void complete();
                  }
                }}
                style={{ paddingRight: 48, width: '100%', boxSizing: 'border-box' }}
              />
              <div style={{ position: 'absolute', right: 8, bottom: 8 }}>
                <IconButton
                  icon={recording ? Square : Mic}
                  label={recording ? 'Остановить запись' : 'Надиктовать'}
                  variant={recording ? 'primary' : 'outline'}
                  size="sm"
                  onClick={recording ? dictation.stop : () => void dictation.start()}
                  disabled={Boolean(busy) || processing}
                />
              </div>
            </div>
            {recording && (
              <p className="ds-field-hint" style={{ margin: 0, color: 'var(--danger)' }}>
                Идёт запись · {Math.floor(dictation.elapsedSec / 60)}:{String(dictation.elapsedSec % 60).padStart(2, '0')} — нажмите ■, чтобы закончить
              </p>
            )}
            {dictation.error && <Alert tone="danger">{dictation.error}</Alert>}
          </>
        )}

        {error && <Alert tone="danger">{error}</Alert>}

        {active && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {primary === 'answer' && (
              <Button variant="primary" onClick={answer} disabled={locked || !trimmed} loading={busy === 'answer'}>
                Ответить
              </Button>
            )}
            {primary === 'complete' && (
              <Button variant="primary" onClick={complete} disabled={locked} loading={busy === 'complete'}>
                Завершить приём
              </Button>
            )}
            <Button variant={primary === 'delegate' ? 'primary' : 'secondary'} onClick={delegate} disabled={locked} loading={busy === 'delegate'}>
              Разберитесь сами
            </Button>
            {waiting && (
              <Button
                variant="secondary"
                onClick={call}
                disabled={locked || hasOtherCalled}
                loading={busy === 'call'}
                title={hasOtherCalled ? 'Сначала завершите текущий приём или верните вопрос в очередь' : undefined}
              >
                Заходите
              </Button>
            )}
            {waiting && primary !== 'answer' && (
              <Button variant="secondary" onClick={answer} disabled={locked || !trimmed} loading={busy === 'answer'}>
                Ответить
              </Button>
            )}
            {waiting && (
              <Button variant="ghost" onClick={moveToEnd} disabled={locked} loading={busy === 'moveToEnd'}>
                В конец очереди
              </Button>
            )}
            {item.status === 'CALLED' && (
              <Button variant="ghost" onClick={returnToQueue} disabled={locked} loading={busy === 'returnToQueue'}>
                Вернуть в очередь
              </Button>
            )}
            {waiting && (
              <Button variant="ghost" onClick={reject} disabled={locked} loading={busy === 'reject'} title="Текст из поля уйдёт сотруднику как причина">
                Отказать
              </Button>
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
}

// --- доска ---

export function ReceptionBoard() {
  const searchParams = useSearchParams();
  // «Стол руководителя» ведёт сюда с ?focus=<id> — открываем этот вопрос.
  const focusId = searchParams.get('focus');
  const [data, setData] = useState<ReceptionBoardView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [opened, setOpened] = useState<{ id: string; intent: Intent } | null>(null);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [overColumn, setOverColumn] = useState<ColumnId | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [focusHandled, setFocusHandled] = useState(false);
  const requestIdRef = useRef(0);

  const load = useCallback(() => {
    const requestId = ++requestIdRef.current;
    api
      .get<ReceptionBoardView>('/reception/board')
      .then((r) => {
        if (requestId !== requestIdRef.current) return;
        setData(r);
        setError(null);
      })
      .catch((err) => {
        if (requestId !== requestIdRef.current) return;
        setError(err instanceof ApiError ? err.message : 'Не удалось загрузить приёмную');
      });
  }, []);

  useEffect(load, [load]);

  // Опрос, пока вкладка видна и руководитель ничего не делает с карточкой.
  const paused = Boolean(opened || draggedId);
  useEffect(() => {
    if (paused) return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') load();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [paused, load]);

  const all: ReceptionRequestItem[] = data ? [...(data.current ? [data.current] : []), ...data.waiting, ...data.delegated, ...data.answered] : [];
  const byId = (id: string | null) => (id ? (all.find((i) => i.id === id) ?? null) : null);
  const dragged = byId(draggedId);
  const openedItem = opened ? byId(opened.id) : null;
  const focusMissing = Boolean(focusId && data && !byId(focusId));

  // Переход со «Стола руководителя» — открыть карточку один раз.
  if (focusId && data && !focusHandled && byId(focusId)) {
    setFocusHandled(true);
    setOpened({ id: focusId, intent: null });
  }

  const hasCurrent = Boolean(data?.current);

  function canDrop(item: ReceptionRequestItem, column: ColumnId): boolean {
    if (item.status === 'WAITING') return column !== 'called' || !hasCurrent;
    if (item.status === 'CALLED') return column !== 'called';
    return false;
  }

  async function quickAction(item: ReceptionRequestItem, path: 'call' | 'move-to-end' | 'return-to-queue') {
    setBusyId(item.id);
    setError(null);
    try {
      await api.post(`/reception/requests/${item.id}/${path}`, { version: item.version }, { 'Idempotency-Key': crypto.randomUUID() });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось выполнить действие');
    } finally {
      setBusyId(null);
      load();
    }
  }

  function drop(item: ReceptionRequestItem, column: ColumnId) {
    if (!canDrop(item, column)) return;
    if (column === 'queue') void quickAction(item, item.status === 'CALLED' ? 'return-to-queue' : 'move-to-end');
    else if (column === 'called') void quickAction(item, 'call');
    else if (column === 'delegated') setOpened({ id: item.id, intent: 'delegate' });
    else setOpened({ id: item.id, intent: item.status === 'CALLED' ? 'complete' : 'answer' });
  }

  function columnItems(column: ColumnId): ReceptionRequestItem[] {
    if (!data) return [];
    const items =
      column === 'queue' ? data.waiting : column === 'called' ? (data.current ? [data.current] : []) : column === 'delegated' ? data.delegated : data.answered;
    return items.filter((i) => matchesSearch(i, search.trim()));
  }

  function columnCount(column: ColumnId): number {
    if (!data) return 0;
    if (column === 'queue') return data.totalWaiting;
    return columnItems(column).length;
  }

  if (error && !data) return <Alert tone="danger">{error}</Alert>;
  if (!data) return <p className="ds-field-hint">Загрузка…</p>;

  return (
    <>
      <div className="board-filters" style={{ alignItems: 'center' }}>
        <div style={{ flex: '1 1 240px', maxWidth: 420 }}>
          <SearchInput value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Поиск по теме или сотруднику" />
        </div>
        <IconButton icon={RefreshCw} label="Обновить" variant="outline" size="sm" onClick={load} />
      </div>

      {focusMissing && (
        <div style={{ marginBottom: 12 }}>
          <Alert tone="info">Статус вопроса изменился</Alert>
        </div>
      )}
      {error && (
        <div style={{ marginBottom: 12 }}>
          <Alert tone="danger">{error}</Alert>
        </div>
      )}

      <div className="board-scroll">
        <div className="board">
          {COLUMNS.map((column) => {
            const items = columnItems(column.id);
            const dropAllowed = dragged ? canDrop(dragged, column.id) : false;
            // «Очередь» как цель: ожидающий вопрос — в конец, вызванный — обратно.
            const queueHint = dragged && column.id === 'queue' && dropAllowed ? (dragged.status === 'CALLED' ? 'Вернуть в очередь' : 'В конец очереди') : null;
            return (
              <section
                key={column.id}
                className={cx('ds-col', overColumn === column.id && dropAllowed && 'is-over')}
                style={{ flex: '1 1 0', minWidth: 240, width: 'auto', opacity: dragged && !dropAllowed ? 0.55 : 1 }}
                aria-label={column.label}
                onDragOver={(e) => {
                  if (!dropAllowed) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                  setOverColumn(column.id);
                }}
                onDragLeave={() => setOverColumn((c) => (c === column.id ? null : c))}
                onDrop={(e) => {
                  e.preventDefault();
                  setOverColumn(null);
                  if (dragged && dropAllowed) drop(dragged, column.id);
                  setDraggedId(null);
                }}
              >
                <header className="ds-col-head">
                  <span style={{ width: 8, height: 8, borderRadius: 999, background: column.dot }} />
                  {column.label}
                  <span className="ds-col-count">{columnCount(column.id)}</span>
                </header>
                {items.length === 0 && !queueHint && <div className="ds-col-empty">{column.id === 'queue' && search ? 'Ничего не найдено' : column.empty}</div>}
                {items.map((item) => (
                  <RequestCard
                    key={item.id}
                    item={item}
                    draggable={(item.status === 'WAITING' || item.status === 'CALLED') && busyId !== item.id}
                    dragging={draggedId === item.id}
                    highlighted={focusId === item.id}
                    onOpen={() => setOpened({ id: item.id, intent: null })}
                    onDragStart={(e) => {
                      setDraggedId(item.id);
                      e.dataTransfer.effectAllowed = 'move';
                      e.dataTransfer.setData('text/plain', item.id);
                    }}
                    onDragEnd={() => {
                      setDraggedId(null);
                      setOverColumn(null);
                    }}
                  />
                ))}
                {queueHint && <div className="ds-col-empty">↓ {queueHint}</div>}
                {column.id === 'queue' && data.totalWaiting > data.waiting.length && (
                  <p className="ds-field-hint" style={{ margin: 0, padding: '0 6px' }}>
                    Показаны первые {data.waiting.length} из {data.totalWaiting}
                  </p>
                )}
              </section>
            );
          })}
        </div>
      </div>

      {opened && openedItem && (
        <RequestDialog
          key={`${openedItem.id}-${opened.intent ?? 'open'}`}
          item={openedItem}
          intent={opened.intent}
          hasOtherCalled={hasCurrent && data.current?.id !== openedItem.id}
          notificationStatus={data.current?.id === openedItem.id ? data.current.notificationStatus : null}
          onClose={() => setOpened(null)}
          onDone={() => {
            setOpened(null);
            load();
          }}
        />
      )}
    </>
  );
}
