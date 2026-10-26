'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { ArrowDownToLine, CheckCheck, DoorOpen, GripVertical, Handshake, ListPlus, Mic, Paperclip, Pencil, Plus, RefreshCw, Square, X, type LucideIcon } from 'lucide-react';
import type {
  AnswerReceptionRequestInput,
  CompleteReceptionRequestInput,
  DelegateReceptionRequestInput,
  EmployeeSummary,
  ReceptionAnswerTemplate,
  ReceptionBoardView,
  ReceptionRequestItem,
  ReceptionRequestType,
  RejectReceptionRequestInput,
  ReorderReceptionRequestInput,
} from '@ai-task-system/shared-types';
import { api, ApiError } from '@/lib/api';
import { useIdempotencyKey } from '@/lib/use-idempotency-key';
import { useDictation } from '@/lib/use-dictation';
import { useRealtime } from '@/lib/use-realtime';
import { Alert, Badge, Button, Dialog, IconButton, Input, SearchInput, Select, Textarea, cx } from '@/components/ui';
import { Avatar } from '@/components/avatar';
import { ReceptionAttachmentList } from '@/components/reception-attachments';

// Приёмная руководителя (владелец 20.10.2026): по центру — весь список
// вопросов, по бокам — «облака». Карточку бросают в облако: слева
// «Заходите» (вызвать) и «В конец очереди», справа «Разберитесь сами» и
// «Отвечено» (открывается карточка с полем ответа — текстом или голосом).
// Клик по карточке — все действия сразу. Перетаскивание на pointer-событиях,
// а не HTML5 DnD: работает и пальцем (за ручку), карточка летит за курсором
// и «впитывается» облаком.

// Изменения приходят мгновенно (useRealtime); опрос — подстраховка на случай
// обрыва потока.
const POLL_MS = 60_000;
const DRAG_THRESHOLD_PX = 5;
const GHOST_MAX_WIDTH = 320;

const REQUEST_TYPE_LABELS: Record<ReceptionRequestType, string> = {
  DECISION: 'Решение',
  APPROVAL: 'Согласование',
  DISCUSSION: 'Обсуждение',
  HELP: 'Помощь',
};

type Intent = 'answer' | 'delegate' | 'complete' | null;
type CloudId = 'call' | 'end' | 'delegate' | 'answer';

interface CloudDef {
  id: CloudId;
  label: string;
  color: string;
  icon: LucideIcon;
  side: 'left' | 'right';
}

const CLOUDS: CloudDef[] = [
  { id: 'call', label: 'Заходите', color: 'var(--warn)', icon: DoorOpen, side: 'left' },
  { id: 'end', label: 'В конец очереди', color: 'var(--ink-3)', icon: ArrowDownToLine, side: 'left' },
  { id: 'delegate', label: 'Разберитесь сами', color: 'var(--info)', icon: Handshake, side: 'right' },
  { id: 'answer', label: 'Отвечено', color: 'var(--ok)', icon: CheckCheck, side: 'right' },
];

function formatDateTime(value: string | null): string {
  return value ? new Date(value).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
}

function formatTime(value: string | null): string {
  return value ? new Date(value).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '';
}

// «ждёт 2 ч 15 мин» — сколько человек уже в очереди.
function waitingFor(createdAt: string, now: number): string {
  const minutes = Math.max(0, Math.round((now - new Date(createdAt).getTime()) / 60_000));
  if (minutes < 1) return 'только что';
  if (minutes < 60) return `ждёт ${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `ждёт ${hours} ч ${minutes % 60} мин`;
  return `ждёт ${Math.floor(hours / 24)} дн`;
}

function isExpired(item: ReceptionRequestItem): boolean {
  return Boolean(item.desiredBy && new Date(item.desiredBy).getTime() < Date.now());
}

function matchesSearch(item: ReceptionRequestItem, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return item.title.toLowerCase().includes(q) || item.author.fullName.toLowerCase().includes(q);
}

// --- карточка вопроса: подробности, действия, ответ текстом/голосом ---

function RequestDialog({
  item,
  intent,
  hasOtherCalled,
  notificationStatus,
  templates,
  employees,
  onTemplatesChange,
  onClose,
  onDone,
}: {
  item: ReceptionRequestItem;
  intent: Intent;
  hasOtherCalled: boolean;
  notificationStatus: string | null;
  templates: ReceptionAnswerTemplate[];
  employees: EmployeeSummary[];
  onTemplatesChange: (next: ReceptionAnswerTemplate[]) => void;
  onClose: () => void;
  onDone: () => void;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editTemplates, setEditTemplates] = useState(false);
  // «Ответить и поставить задачу»: по умолчанию — автору вопроса, тема — тема вопроса.
  const [task, setTask] = useState<{ title: string; assigneeId: string; dueDate: string } | null>(null);
  const idem = useIdempotencyKey();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [dictationFields] = useState(() => ({ requestId: item.id }));
  const dictation = useDictation(
    '/reception/transcribe',
    (spoken) => {
      setText((prev) => (prev.trim() ? `${prev.trimEnd()}\n${spoken}` : spoken));
      textareaRef.current?.focus();
    },
    dictationFields,
  );

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

  const taskReady = !task || task.title.trim().length > 0;
  const answer = () =>
    run('answer', 'answer', {
      version: item.version,
      text: trimmed,
      task: task
        ? {
            title: task.title.trim(),
            assigneeId: task.assigneeId,
            // Срок — конец выбранного дня по местному времени.
            dueDate: task.dueDate ? new Date(`${task.dueDate}T18:00:00`).toISOString() : undefined,
          }
        : undefined,
    } satisfies AnswerReceptionRequestInput);

  function insertTemplate(t: ReceptionAnswerTemplate) {
    setText((prev) => (prev.trim() ? `${prev.trimEnd()} ${t.text}` : t.text));
    textareaRef.current?.focus();
  }

  async function saveTemplate() {
    try {
      const created = await api.post<ReceptionAnswerTemplate>('/reception/templates', { text: trimmed });
      if (!templates.some((t) => t.id === created.id)) onTemplatesChange([...templates, created]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось сохранить шаблон');
    }
  }

  async function deleteTemplate(t: ReceptionAnswerTemplate) {
    onTemplatesChange(templates.filter((x) => x.id !== t.id));
    try {
      await api.delete(`/reception/templates/${t.id}`);
    } catch {
      onTemplatesChange(templates); // вернуть как было
    }
  }
  const delegate = () => run('delegate', 'delegate', { version: item.version, comment: trimmed || undefined } satisfies DelegateReceptionRequestInput);
  const complete = () => run('complete', 'complete', { version: item.version, resolution: trimmed || undefined } satisfies CompleteReceptionRequestInput);
  const reject = () => run('reject', 'reject', { version: item.version, reason: trimmed || undefined } satisfies RejectReceptionRequestInput);
  const call = () => run('call', 'call', { version: item.version });
  const moveToEnd = () => run('moveToEnd', 'move-to-end', { version: item.version });
  const returnToQueue = () => run('returnToQueue', 'return-to-queue', { version: item.version });

  // Главная кнопка — по тому, куда перетащили карточку; по клику на
  // ожидающий вопрос — «Ответить», на вызванного — «Завершить приём».
  const primary = task ? 'answer' : intent === 'delegate' ? 'delegate' : intent === 'answer' || (intent === null && waiting) ? 'answer' : 'complete';
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

        <ReceptionAttachmentList requestId={item.id} attachments={item.attachments} />

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
        {item.task && (
          <Link className="rcp-task-link" href={`/tasks/${item.task.id}`}>
            <ListPlus size={16} strokeWidth={1.75} />
            Задача: {item.task.title}
            {item.task.assignee && ` · ${item.task.assignee.fullName}`}
            {item.task.dueDate && ` · до ${new Date(item.task.dueDate).toLocaleDateString('ru-RU')}`}
          </Link>
        )}

        {active && (
          <>
            <div style={{ position: 'relative' }}>
              <Textarea
                ref={textareaRef}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={processing ? 'Распознаю и оформляю ответ…' : placeholder}
                maxLength={3000}
                rows={4}
                disabled={processing}
                onKeyDown={(e) => {
                  // Ctrl/⌘+Enter — выполнить главное действие.
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !locked) {
                    e.preventDefault();
                    if (primary === 'answer' && trimmed && taskReady) void answer();
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
            {(recording || processing) && dictation.liveText && (
              <p className="live-transcript" aria-live="polite">
                {dictation.liveText}
              </p>
            )}
            {dictation.error && <Alert tone="danger">{dictation.error}</Alert>}

            <div className="rcp-templates">
              {templates.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className={cx('rcp-template', editTemplates && 'is-editing')}
                  onClick={() => (editTemplates ? void deleteTemplate(t) : insertTemplate(t))}
                  disabled={locked}
                  title={editTemplates ? 'Удалить шаблон' : t.text}
                >
                  {t.text}
                  {editTemplates && <X size={12} strokeWidth={2} />}
                </button>
              ))}
              {editTemplates && trimmed && trimmed.length <= 500 && !templates.some((t) => t.text === trimmed) && (
                <button type="button" className="rcp-template is-add" onClick={() => void saveTemplate()} disabled={locked}>
                  <Plus size={12} strokeWidth={2} />
                  Сохранить текст как шаблон
                </button>
              )}
              <IconButton
                icon={editTemplates ? CheckCheck : Pencil}
                label={editTemplates ? 'Готово' : 'Настроить шаблоны'}
                size="sm"
                onClick={() => setEditTemplates((v) => !v)}
              />
            </div>

            {task ? (
              <div className="rcp-task">
                <div className="rcp-task-head">
                  <ListPlus size={16} strokeWidth={1.75} />
                  <strong>Задача</strong>
                  <IconButton icon={X} label="Без задачи" size="sm" onClick={() => setTask(null)} />
                </div>
                <Input value={task.title} onChange={(e) => setTask({ ...task, title: e.target.value })} placeholder="Что сделать" maxLength={300} />
                <div className="rcp-task-row">
                  <Select
                    value={task.assigneeId}
                    onChange={(e) => setTask({ ...task, assigneeId: e.target.value })}
                    aria-label="Исполнитель"
                    options={(employees.some((e) => e.id === item.author.id) ? employees : [item.author, ...employees]).map((e) => ({
                      value: e.id,
                      label: e.id === item.author.id ? `${e.fullName} — автор вопроса` : e.fullName,
                    }))}
                  />
                  <Input type="date" value={task.dueDate} onChange={(e) => setTask({ ...task, dueDate: e.target.value })} aria-label="Срок" />
                </div>
              </div>
            ) : (
              <div>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={ListPlus}
                  onClick={() => setTask({ title: item.title, assigneeId: item.author.id, dueDate: '' })}
                  disabled={locked}
                >
                  Ответить и поставить задачу
                </Button>
              </div>
            )}
          </>
        )}

        {error && <Alert tone="danger">{error}</Alert>}

        {active && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {primary === 'answer' && (
              <Button variant="primary" onClick={answer} disabled={locked || !trimmed || !taskReady} loading={busy === 'answer'}>
                {task ? 'Ответить и поставить задачу' : 'Ответить'}
              </Button>
            )}
            {primary === 'complete' && (
              <Button variant="primary" onClick={complete} disabled={locked} loading={busy === 'complete'}>
                Завершить приём
              </Button>
            )}
            {!task && (
              <Button variant={primary === 'delegate' ? 'primary' : 'secondary'} onClick={delegate} disabled={locked} loading={busy === 'delegate'}>
                Разберитесь сами
              </Button>
            )}
            {waiting && !task && (
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
            {waiting && primary !== 'answer' && !task && (
              <Button variant="secondary" onClick={answer} disabled={locked || !trimmed} loading={busy === 'answer'}>
                Ответить
              </Button>
            )}
            {waiting && !task && (
              <Button variant="ghost" onClick={moveToEnd} disabled={locked} loading={busy === 'moveToEnd'}>
                В конец очереди
              </Button>
            )}
            {item.status === 'CALLED' && !task && (
              <Button variant="ghost" onClick={returnToQueue} disabled={locked} loading={busy === 'returnToQueue'}>
                Вернуть в очередь
              </Button>
            )}
            {waiting && !task && (
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

// --- карточка в центральном списке ---

function QueueCard({
  item,
  position,
  now,
  lifted,
  shifted,
  highlighted,
  cardRef,
  onPointerDown,
  onOpen,
}: {
  item: ReceptionRequestItem;
  position: number | null;
  now: number;
  lifted: boolean;
  shifted: boolean;
  highlighted: boolean;
  cardRef: (el: HTMLElement | null) => void;
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
  onOpen: () => void;
}) {
  const called = item.status === 'CALLED';
  const expired = isExpired(item);
  return (
    <article
      ref={cardRef}
      className={cx('rcp-card', called && 'is-called', lifted && 'is-lifted', shifted && 'is-shifted', highlighted && 'is-highlighted')}
      tabIndex={0}
      role="button"
      aria-label={`${item.author.fullName}: ${item.title}`}
      onPointerDown={onPointerDown}
      onClick={onOpen}
      onKeyDown={(e: KeyboardEvent<HTMLElement>) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      <span className="rcp-grip" data-grip aria-hidden>
        <GripVertical size={16} strokeWidth={1.75} />
      </span>
      <div className="rcp-card-pos">{called ? <DoorOpen size={16} strokeWidth={1.75} /> : position}</div>
      <div className="rcp-card-body">
        <div className="rcp-card-who">
          <Avatar id={item.author.id} name={item.author.fullName} size={22} />
          <span className="rcp-card-name">{item.author.fullName}</span>
          <span className="rcp-card-wait">{called ? `на приёме с ${formatTime(item.lastCalledAt)}` : waitingFor(item.createdAt, now)}</span>
        </div>
        <h3 className="rcp-card-title">{item.title}</h3>
        <div className="rcp-card-meta">
          <Badge>{REQUEST_TYPE_LABELS[item.requestType]}</Badge>
          {item.expectedMinutes && <Badge>~{item.expectedMinutes} мин</Badge>}
          {item.desiredBy && <Badge tone={expired ? 'danger' : 'warn'}>{expired ? 'срок истёк' : `до ${formatDateTime(item.desiredBy)}`}</Badge>}
          {item.attachments.length > 0 && (
            <Badge>
              <Paperclip size={12} strokeWidth={2} aria-label="Файлы" /> {item.attachments.length}
            </Badge>
          )}
          {item.author.status === 'INACTIVE' && <Badge>неактивен</Badge>}
        </div>
      </div>
      {expired && <span className="rcp-urgent" aria-hidden />}
    </article>
  );
}

// --- облако ---

type CloudState = 'idle' | 'ready' | 'over' | 'blocked' | 'blocked-over';

function burstDots(color: string) {
  return Array.from({ length: 12 }, (_, i) => {
    const angle = (i / 12) * Math.PI * 2;
    const distance = 70 + (i % 3) * 18;
    const style = {
      '--dx': `${Math.cos(angle) * distance}px`,
      '--dy': `${Math.sin(angle) * distance}px`,
      background: color,
      animationDelay: `${(i % 4) * 25}ms`,
    } as CSSProperties;
    return <span key={i} style={style} />;
  });
}

function Cloud({
  def,
  state,
  index,
  subtitle,
  overText,
  people,
  count,
  gulpKey,
  shakeKey,
  cloudRef,
  onClick,
}: {
  def: CloudDef;
  state: CloudState;
  index: number;
  subtitle: string;
  overText: string;
  people: ReceptionRequestItem[];
  count: number | null;
  gulpKey: number;
  shakeKey: number;
  cloudRef: (el: HTMLDivElement | null) => void;
  onClick?: () => void;
}) {
  const Icon = def.icon;
  return (
    <div className="rcp-cloud-wrap" style={{ animationDelay: `${index * -1.7}s` }}>
      <div
        ref={cloudRef}
        className={cx('rcp-cloud', `is-${state}`, onClick && 'is-clickable')}
        style={{ '--c': def.color } as CSSProperties}
        role={onClick ? 'button' : undefined}
        tabIndex={onClick ? 0 : undefined}
        onClick={onClick}
        onKeyDown={(e) => {
          if (onClick && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            onClick();
          }
        }}
      >
        <div key={`g${gulpKey}-s${shakeKey}`} className={cx('rcp-cloud-inner', gulpKey > 0 && 'is-gulp', shakeKey > 0 && 'is-shake')}>
          <span className="rcp-cloud-icon">
            <Icon size={22} strokeWidth={1.75} />
          </span>
          <span className="rcp-cloud-label">
            {def.label}
            {count !== null && (
              <span key={count} className="rcp-cloud-count">
                {count}
              </span>
            )}
          </span>
          <span className="rcp-cloud-sub">{state === 'over' || state === 'blocked-over' ? overText : subtitle}</span>
          {people.length > 0 && (
            <span className="rcp-cloud-people">
              {people.slice(0, 4).map((p) => (
                <Avatar key={p.id} id={p.author.id} name={p.author.fullName} size={22} />
              ))}
            </span>
          )}
        </div>
        {gulpKey > 0 && (
          <span key={gulpKey} className="rcp-burst" aria-hidden>
            {burstDots(def.color)}
          </span>
        )}
      </div>
    </div>
  );
}

// --- список закрытых в облаке («Разберитесь сами» / «Отвечено») ---

function CloudListDialog({
  title,
  items,
  onPick,
  onClose,
}: {
  title: string;
  items: ReceptionRequestItem[];
  onPick: (item: ReceptionRequestItem) => void;
  onClose: () => void;
}) {
  return (
    <Dialog title={title} description="За последние 7 дней" onClose={onClose}>
      {items.length === 0 ? (
        <p className="ds-field-hint">Пока пусто.</p>
      ) : (
        <ul className="rcp-closed-list">
          {items.map((item) => (
            <li key={item.id}>
              <button type="button" onClick={() => onPick(item)}>
                <span className="rcp-card-who">
                  <Avatar id={item.author.id} name={item.author.fullName} size={22} />
                  <span className="rcp-card-name">{item.author.fullName}</span>
                  <span className="rcp-card-wait">
                    {item.status === 'COMPLETED' ? 'обсудили · ' : ''}
                    {formatDateTime(item.closedAt)}
                  </span>
                </span>
                <strong>{item.title}</strong>
                {item.resolution && <span className="rcp-closed-text">{item.resolution}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}

// --- сцена: облака + список ---

interface DragSession {
  item: ReceptionRequestItem;
  origin: HTMLElement;
  pointerId: number;
  startX: number;
  startY: number;
  offsetX: number;
  offsetY: number;
  width: number;
  active: boolean;
  lastX: number;
  tilt: number;
  over: CloudId | null;
  slot: Slot | null;
  transform: string;
}

// Место вставки при перестановке внутри очереди: перед beforeId (null — в
// конец), y — где рисовать линию, от верха списка.
interface Slot {
  beforeId: string | null;
  y: number;
}

const LIST_GAP_PX = 10; // .rcp-list gap

const EMPTY_CLOUD_COUNTERS: Record<CloudId, number> = { call: 0, end: 0, delegate: 0, answer: 0 };

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function ReceptionBoard() {
  const searchParams = useSearchParams();
  // «Стол руководителя» ведёт сюда с ?focus=<id> — открываем этот вопрос.
  const focusId = searchParams.get('focus');
  const [data, setData] = useState<ReceptionBoardView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [opened, setOpened] = useState<{ id: string; intent: Intent } | null>(null);
  const [cloudList, setCloudList] = useState<'delegate' | 'answer' | null>(null);
  const [dragItem, setDragItem] = useState<ReceptionRequestItem | null>(null);
  const [ghostWidth, setGhostWidth] = useState(0);
  const [overCloud, setOverCloud] = useState<CloudId | null>(null);
  const [slot, setSlot] = useState<Slot | null>(null);
  const [templates, setTemplates] = useState<ReceptionAnswerTemplate[]>([]);
  const [employees, setEmployees] = useState<EmployeeSummary[]>([]);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [gulps, setGulps] = useState(EMPTY_CLOUD_COUNTERS);
  const [shakes, setShakes] = useState(EMPTY_CLOUD_COUNTERS);
  const [now, setNow] = useState(() => Date.now());
  const [focusHandled, setFocusHandled] = useState(false);
  const requestIdRef = useRef(0);
  const dragRef = useRef<DragSession | null>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const cloudEls = useRef<Partial<Record<CloudId, HTMLDivElement | null>>>({});
  const listRef = useRef<HTMLDivElement>(null);
  const cardEls = useRef(new Map<string, HTMLElement>());
  const prevOffsets = useRef(new Map<string, number>());
  const suppressClickRef = useRef(false);

  const load = useCallback((): Promise<void> => {
    const requestId = ++requestIdRef.current;
    return api
      .get<ReceptionBoardView>('/reception/board')
      .then((r) => {
        if (requestId !== requestIdRef.current) return;
        setData(r);
        setError(null);
      })
      .catch((err: unknown) => {
        if (requestId !== requestIdRef.current) return;
        setError(err instanceof ApiError ? err.message : 'Не удалось загрузить приёмную');
      });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Шаблоны и сотрудники (исполнитель задачи) — один раз, не на каждом опросе.
  useEffect(() => {
    api.get<ReceptionAnswerTemplate[]>('/reception/templates').then(setTemplates).catch(() => {});
    api.get<EmployeeSummary[]>('/employees').then(setEmployees).catch(() => {});
  }, []);

  const paused = Boolean(opened || dragItem || cloudList);
  // Пока руководитель перетаскивает карточку или держит открытым диалог,
  // список не перестраивается под ним — изменение применится после.
  const pausedRef = useRef(paused);
  const staleRef = useRef(false);
  useEffect(() => {
    pausedRef.current = paused;
    if (!paused && staleRef.current) {
      staleRef.current = false;
      void load();
    }
  }, [paused, load]);
  useRealtime('reception', () => {
    if (pausedRef.current) staleRef.current = true;
    else void load();
  });
  useEffect(() => {
    if (paused) return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [paused, load]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  // Плавная перестановка списка (FLIP): карточка, сменившая место,
  // доезжает до него, а не прыгает.
  useLayoutEffect(() => {
    const next = new Map<string, number>();
    const animate = !prefersReducedMotion();
    cardEls.current.forEach((el, id) => {
      const top = el.offsetTop;
      next.set(id, top);
      const prev = prevOffsets.current.get(id);
      if (animate && prev !== undefined && Math.abs(prev - top) > 2) {
        el.animate([{ transform: `translateY(${prev - top}px)` }, { transform: 'none' }], { duration: 380, easing: 'cubic-bezier(.2,.8,.2,1)' });
      }
    });
    prevOffsets.current = next;
  });

  const current = data?.current ?? null;
  const all: ReceptionRequestItem[] = data ? [...(current ? [current] : []), ...data.waiting, ...data.delegated, ...data.answered] : [];
  const byId = (id: string | null) => (id ? (all.find((i) => i.id === id) ?? null) : null);
  const openedItem = opened ? byId(opened.id) : null;
  const focusMissing = Boolean(focusId && data && !byId(focusId));

  if (focusId && data && !focusHandled && byId(focusId)) {
    setFocusHandled(true);
    setOpened({ id: focusId, intent: null });
  }

  function canDrop(item: ReceptionRequestItem, cloud: CloudId): boolean {
    if (item.status === 'WAITING') return cloud !== 'call' || !current;
    if (item.status === 'CALLED') return cloud !== 'call';
    return false;
  }

  function bump(setter: typeof setGulps, cloud: CloudId) {
    setter((prev) => ({ ...prev, [cloud]: prev[cloud] + 1 }));
  }

  function markPending(id: string, on: boolean) {
    setPending((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  async function quickAction(item: ReceptionRequestItem, path: 'call' | 'move-to-end' | 'return-to-queue', cloud: CloudId) {
    markPending(item.id, true);
    setError(null);
    try {
      await api.post(`/reception/requests/${item.id}/${path}`, { version: item.version }, { 'Idempotency-Key': crypto.randomUUID() });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось выполнить действие');
      bump(setShakes, cloud);
      void load();
    } finally {
      markPending(item.id, false);
    }
  }

  function perform(item: ReceptionRequestItem, cloud: CloudId) {
    if (cloud === 'call') void quickAction(item, 'call', cloud);
    else if (cloud === 'end') void quickAction(item, item.status === 'CALLED' ? 'return-to-queue' : 'move-to-end', cloud);
    else {
      markPending(item.id, true);
      setOpened({ id: item.id, intent: cloud === 'delegate' ? 'delegate' : item.status === 'CALLED' ? 'complete' : 'answer' });
    }
  }

  // Перестановка внутри очереди: сразу двигаем карточку локально (FLIP
  // доводит её до места), сервер подтверждает, опрос сверяет.
  async function reorderTo(item: ReceptionRequestItem, beforeId: string | null) {
    setData((prev) => {
      if (!prev) return prev;
      const rest = prev.waiting.filter((w) => w.id !== item.id);
      const at = beforeId ? rest.findIndex((w) => w.id === beforeId) : rest.length;
      return { ...prev, waiting: [...rest.slice(0, at), item, ...rest.slice(at)] };
    });
    setError(null);
    try {
      await api.post(
        `/reception/requests/${item.id}/reorder`,
        { version: item.version, beforeId: beforeId ?? undefined } satisfies ReorderReceptionRequestInput,
        { 'Idempotency-Key': crypto.randomUUID() },
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось переставить вопрос');
    }
    void load();
  }

  // --- перетаскивание ---

  function slotAt(item: ReceptionRequestItem, x: number, y: number): Slot | null {
    const listEl = listRef.current;
    if (!listEl || !data || item.status !== 'WAITING' || search.trim()) return null;
    const r = listEl.getBoundingClientRect();
    if (x < r.left - 40 || x > r.right + 40 || y < r.top - 40 || y > r.bottom + 40) return null;
    const py = y - r.top;
    let next: Slot | null = null;
    for (const w of data.waiting) {
      if (w.id === item.id) continue;
      const el = cardEls.current.get(w.id);
      if (!el) continue;
      // offsetTop не зависит от transform — раздвинутые карточки не «дрожат».
      if (py < el.offsetTop + el.offsetHeight / 2) {
        next = { beforeId: w.id, y: el.offsetTop }; // карточка уедет вниз — линия в открывшейся щели
        break;
      }
      next = { beforeId: null, y: el.offsetTop + el.offsetHeight + LIST_GAP_PX / 2 - 2 };
    }
    if (!next) return null;
    // То же место, где карточка и так стоит, — не предлагаем.
    const index = data.waiting.findIndex((w) => w.id === item.id);
    const after = data.waiting[index + 1]?.id ?? null;
    return next.beforeId === after ? null : next;
  }

  function cloudAt(x: number, y: number): CloudId | null {
    for (const def of CLOUDS) {
      const el = cloudEls.current[def.id];
      if (!el) continue;
      const r = el.getBoundingClientRect();
      const pad = 28;
      if (x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad) return def.id;
    }
    return null;
  }

  function applyGhost(transform: string) {
    if (dragRef.current) dragRef.current.transform = transform;
    if (ghostRef.current) ghostRef.current.style.transform = transform;
  }

  // Призрак появляется после рендера — ставим его в текущую позицию сразу.
  useLayoutEffect(() => {
    if (dragItem && ghostRef.current && dragRef.current) ghostRef.current.style.transform = dragRef.current.transform;
  }, [dragItem]);

  function onCardPointerDown(e: ReactPointerEvent<HTMLElement>, item: ReceptionRequestItem) {
    if (e.button !== 0 || dragRef.current) return;
    // Пальцем — только за ручку, иначе список не прокрутить.
    if (e.pointerType === 'touch' && !(e.target as HTMLElement).closest('[data-grip]')) return;
    const origin = e.currentTarget;
    const rect = origin.getBoundingClientRect();
    // Летящая карточка компактнее строки списка — иначе широкая карточка
    // перекрывает облако и вылезает за край экрана.
    const width = Math.min(rect.width, GHOST_MAX_WIDTH);
    dragRef.current = {
      item,
      origin,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      offsetX: ((e.clientX - rect.left) * width) / rect.width,
      offsetY: e.clientY - rect.top,
      width,
      active: false,
      lastX: e.clientX,
      tilt: 0,
      over: null,
      slot: null,
      transform: `translate(${rect.left}px, ${rect.top}px)`,
    };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
  }

  function onPointerMove(e: PointerEvent) {
    const s = dragRef.current;
    if (!s || e.pointerId !== s.pointerId) return;
    if (!s.active) {
      if (Math.hypot(e.clientX - s.startX, e.clientY - s.startY) < DRAG_THRESHOLD_PX) return;
      s.active = true;
      document.body.classList.add('rcp-dragging');
      setGhostWidth(s.width);
      setDragItem(s.item);
    }
    e.preventDefault();
    const velocity = e.clientX - s.lastX;
    s.lastX = e.clientX;
    s.tilt = Math.max(-12, Math.min(12, s.tilt * 0.75 + velocity * 0.6));

    const over = cloudAt(e.clientX, e.clientY);
    let x = e.clientX - s.offsetX;
    let y = e.clientY - s.offsetY;
    let scale = 1.03;
    // Над облаком карточку слегка «притягивает» к центру и она уменьшается.
    if (over && canDrop(s.item, over)) {
      const r = cloudEls.current[over]!.getBoundingClientRect();
      const cx = r.left + r.width / 2 - s.width / 2;
      const cy = r.top + r.height / 2 - 40;
      x += (cx - x) * 0.3;
      y += (cy - y) * 0.3;
      scale = 0.82;
    }
    applyGhost(`translate(${x}px, ${y}px) rotate(${s.tilt}deg) scale(${scale})`);
    if (over !== s.over) {
      s.over = over;
      setOverCloud(over);
    }
    const nextSlot = over ? null : slotAt(s.item, e.clientX, e.clientY);
    if (nextSlot?.beforeId !== s.slot?.beforeId || nextSlot?.y !== s.slot?.y) {
      s.slot = nextSlot;
      setSlot(nextSlot);
    }
  }

  function detach() {
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerCancel);
  }

  function endDrag() {
    dragRef.current = null;
    document.body.classList.remove('rcp-dragging');
    setDragItem(null);
    setOverCloud(null);
    setSlot(null);
  }

  function flyBack(s: DragSession) {
    const ghost = ghostRef.current;
    const r = s.origin.getBoundingClientRect();
    if (!ghost || prefersReducedMotion()) return endDrag();
    ghost
      .animate([{ transform: s.transform }, { transform: `translate(${r.left}px, ${r.top}px) rotate(0deg) scale(1)` }], {
        duration: 320,
        easing: 'cubic-bezier(.2,.9,.3,1.2)',
        fill: 'forwards',
      })
      .finished.then(endDrag, endDrag);
  }

  function onPointerCancel() {
    const s = dragRef.current;
    detach();
    if (s?.active) flyBack(s);
    else dragRef.current = null;
  }

  function onPointerUp(e: PointerEvent) {
    const s = dragRef.current;
    if (!s || e.pointerId !== s.pointerId) return;
    detach();
    if (!s.active) {
      dragRef.current = null;
      return; // обычный клик — откроет карточку через onClick
    }
    suppressClickRef.current = true;
    setTimeout(() => (suppressClickRef.current = false), 0);

    const cloud = s.over;
    const target = s.slot;
    if (!cloud && target && listRef.current) {
      const item = s.item;
      const finish = () => {
        endDrag();
        void reorderTo(item, target.beforeId);
      };
      const ghost = ghostRef.current;
      if (!ghost || prefersReducedMotion()) return finish();
      // Карточка «укладывается» в щель между соседями.
      const r = listRef.current.getBoundingClientRect();
      ghost
        .animate(
          [
            { transform: s.transform },
            { transform: `translate(${r.left + (r.width - s.width) / 2}px, ${r.top + target.y - 24}px) rotate(0deg) scale(0.96)` },
          ],
          { duration: 220, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'forwards' },
        )
        .finished.then(finish, finish);
      return;
    }
    if (!cloud || !canDrop(s.item, cloud)) {
      if (cloud) bump(setShakes, cloud);
      flyBack(s);
      return;
    }

    const item = s.item;
    const finish = () => {
      endDrag();
      bump(setGulps, cloud);
      perform(item, cloud);
    };
    const ghost = ghostRef.current;
    const r = cloudEls.current[cloud]!.getBoundingClientRect();
    if (!ghost || prefersReducedMotion()) return finish();
    // Карточка «впитывается» облаком: летит в центр, сжимаясь и тая.
    markPending(item.id, true);
    ghost
      .animate(
        [
          { transform: s.transform, opacity: 1 },
          { transform: `translate(${r.left + r.width / 2 - s.width / 2}px, ${r.top + r.height / 2 - 30}px) rotate(${s.tilt * -1.5}deg) scale(0.12)`, opacity: 0 },
        ],
        { duration: 420, easing: 'cubic-bezier(.55,0,.75,.2)', fill: 'forwards' },
      )
      .finished.then(finish, finish);
  }

  useEffect(() => () => document.body.classList.remove('rcp-dragging'), []);

  if (error && !data) return <Alert tone="danger">{error}</Alert>;
  if (!data) return <p className="ds-field-hint">Загрузка…</p>;

  const query = search.trim();
  const list = [...(current ? [current] : []), ...data.waiting].filter((i) => matchesSearch(i, query));
  const dragging = Boolean(dragItem);
  // Карточки ниже места вставки расступаются.
  const shiftFrom = slot ? (slot.beforeId ? data.waiting.findIndex((w) => w.id === slot.beforeId) : data.waiting.length) : Infinity;

  function cloudState(cloud: CloudId): CloudState {
    if (!dragItem) return 'idle';
    const allowed = canDrop(dragItem, cloud);
    if (overCloud === cloud) return allowed ? 'over' : 'blocked-over';
    return allowed ? 'ready' : 'blocked';
  }

  function cloudProps(def: CloudDef) {
    switch (def.id) {
      case 'call':
        return {
          subtitle: current ? `сейчас: ${current.author.fullName}` : 'кабинет свободен',
          overText: current && dragItem?.id !== current.id ? 'сначала завершите приём' : 'пригласить сейчас',
          people: current ? [current] : [],
          count: null,
          onClick: current ? () => setOpened({ id: current.id, intent: null }) : undefined,
        };
      case 'end':
        return {
          subtitle: `в очереди ${data!.totalWaiting}`,
          overText: dragItem?.status === 'CALLED' ? 'вернуть в очередь' : 'подождёт',
          people: [],
          count: null,
          onClick: undefined,
        };
      case 'delegate':
        return {
          subtitle: 'за неделю',
          overText: 'пусть решит сам',
          people: data!.delegated,
          count: data!.delegated.length,
          onClick: () => setCloudList('delegate'),
        };
      case 'answer':
        return {
          subtitle: 'за неделю',
          overText: dragItem?.status === 'CALLED' ? 'завершить приём' : 'ответить',
          people: data!.answered,
          count: data!.answered.length,
          onClick: () => setCloudList('answer'),
        };
    }
  }

  function renderSide(side: 'left' | 'right') {
    return (
      <div className={cx('rcp-side', `is-${side}`)}>
        {CLOUDS.filter((c) => c.side === side).map((def) => {
          const index = CLOUDS.indexOf(def);
          return (
            <Cloud
              key={def.id}
              def={def}
              index={index}
              state={cloudState(def.id)}
              gulpKey={gulps[def.id]}
              shakeKey={shakes[def.id]}
              cloudRef={(el) => {
                cloudEls.current[def.id] = el;
              }}
              {...cloudProps(def)}
            />
          );
        })}
      </div>
    );
  }

  return (
    <>
      <div className={cx('rcp-stage', dragging && 'is-dragging')}>
        {renderSide('left')}

        <section className="rcp-center" aria-label="Очередь">
          <div className="rcp-center-head">
            <span className="section-kicker">
              Очередь · {data.totalWaiting === 0 ? 'никто не ждёт' : `ждут ${data.totalWaiting}`}
              {current && ' · идёт приём'}
            </span>
            <IconButton icon={RefreshCw} label="Обновить" variant="outline" size="sm" onClick={() => void load()} />
          </div>
          {(data.totalWaiting > 5 || query) && (
            <div className="rcp-center-note">
              <SearchInput value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Поиск по теме или сотруднику" />
            </div>
          )}
          {focusMissing && (
            <div className="rcp-center-note">
              <Alert tone="info">Статус вопроса изменился</Alert>
            </div>
          )}
          {error && (
            <div className="rcp-center-note">
              <Alert tone="danger">{error}</Alert>
            </div>
          )}

          {list.length === 0 ? (
            <div className="rcp-empty">
              <CheckCheck size={28} strokeWidth={1.5} />
              <strong>{query ? 'Ничего не найдено' : 'Очередь пуста'}</strong>
              {!query && <span>Все вопросы разобраны — можно выдохнуть.</span>}
            </div>
          ) : (
            <div className={cx('rcp-list', slot && 'is-sorting')} ref={listRef}>
              {slot && <div className="rcp-drop-line" style={{ top: slot.y }} aria-hidden />}
              {list.map((item) => {
                const index = data.waiting.indexOf(item);
                return (
                  <QueueCard
                    key={item.id}
                    item={item}
                    position={index >= 0 ? index + 1 : null}
                    now={now}
                    lifted={dragItem?.id === item.id || pending.has(item.id)}
                    shifted={Boolean(slot && index >= 0 && item.id !== dragItem?.id && index >= shiftFrom)}
                    highlighted={focusId === item.id}
                    cardRef={(el) => {
                      if (el) cardEls.current.set(item.id, el);
                      else cardEls.current.delete(item.id);
                    }}
                    onPointerDown={(e) => onCardPointerDown(e, item)}
                    onOpen={() => {
                      if (suppressClickRef.current) return;
                      setOpened({ id: item.id, intent: null });
                    }}
                  />
                );
              })}
              {data.totalWaiting > data.waiting.length && (
                <p className="ds-field-hint" style={{ textAlign: 'center' }}>
                  Показаны первые {data.waiting.length} из {data.totalWaiting}
                </p>
              )}
            </div>
          )}
        </section>

        {renderSide('right')}
      </div>

      {dragItem && (
        <div ref={ghostRef} className="rcp-ghost" style={{ width: ghostWidth }} aria-hidden>
          <div className="rcp-card is-ghost">
            <div className="rcp-card-body">
              <div className="rcp-card-who">
                <Avatar id={dragItem.author.id} name={dragItem.author.fullName} size={22} />
                <span className="rcp-card-name">{dragItem.author.fullName}</span>
              </div>
              <h3 className="rcp-card-title">{dragItem.title}</h3>
            </div>
          </div>
        </div>
      )}

      {cloudList && (
        <CloudListDialog
          title={cloudList === 'delegate' ? 'Разберитесь сами' : 'Отвечено'}
          items={cloudList === 'delegate' ? data.delegated : data.answered}
          onClose={() => setCloudList(null)}
          onPick={(item) => {
            setCloudList(null);
            setOpened({ id: item.id, intent: null });
          }}
        />
      )}

      {opened && openedItem && (
        <RequestDialog
          key={`${openedItem.id}-${opened.intent ?? 'open'}`}
          item={openedItem}
          intent={opened.intent}
          hasOtherCalled={Boolean(current) && current?.id !== openedItem.id}
          notificationStatus={current?.id === openedItem.id ? current.notificationStatus : null}
          templates={templates}
          employees={employees}
          onTemplatesChange={setTemplates}
          onClose={() => {
            markPending(openedItem.id, false);
            setOpened(null);
          }}
          onDone={async () => {
            setOpened(null);
            await load();
            markPending(openedItem.id, false);
          }}
        />
      )}
    </>
  );
}
