'use client';

import { useEffect, useRef, useState } from 'react';
import { ChevronRight, MessageSquare } from 'lucide-react';
import type { ReceptionBoardView, ReceptionRequestItem } from '@ai-task-system/shared-types';
import { api, ApiError } from '@/lib/api';
import { companyDate, companyDayKey, companyTime, formatDuration } from '@/lib/company-time';
import { REQUEST_TYPE_LABELS } from '@/lib/labels';
import { notificationHaptic } from '@/lib/telegram';
import { Alert, Dialog, Pill, ScreenHeader, SectionLabel, Skeleton, useAppToast } from '@/components/ui';
import { Avatar } from '../avatar';
import { OverlayPortal } from '../overlay-portal';
import { ReceptionAttachmentList } from '../reception-attachments';
import { ReceptionActions, isQueueChanged, type QuickAction } from './reception-actions';
import { ReceptionSheet, type SheetMode } from './reception-sheet';

// Приёмная руководителя в Mini App (редизайн M4, MINIAPP_REDESIGN.md §4.5):
// раньше здесь были только «мои вопросы», очередь жила в web. Данные —
// GET /reception/board (вызванный + очередь + закрытые за неделю), те же
// переходы и заголовки, что у web reception-board.

const POLL_MS = 15_000;

const NOTIFICATION_HINT: Record<string, string> = {
  SENT: 'уведомление доставлено',
  PENDING: 'уведомление отправляется…',
  FAILED: 'не удалось отправить уведомление',
  SKIPPED: 'Telegram не привязан — позовите сами',
};

function minutesSince(value: string, now: number): number {
  return Math.max(0, Math.round((now - new Date(value).getTime()) / 60_000));
}

function waited(value: string, now: number): string {
  const minutes = minutesSince(value, now);
  // Больше суток — дата подачи, а не «1 452 мин».
  return minutes >= 24 * 60 ? `с ${companyDate(value)}` : formatDuration(minutes);
}

function meta(item: ReceptionRequestItem): string {
  return [REQUEST_TYPE_LABELS[item.requestType], item.expectedMinutes ? `~${item.expectedMinutes} мин` : null].filter(Boolean).join(' · ');
}

export function ManagerReception({ active, onOpenMine }: { active: boolean; onOpenMine?: () => void }) {
  const [board, setBoard] = useState<ReceptionBoardView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [viewId, setViewId] = useState<string | null>(null);
  const [sheet, setSheet] = useState<{ id: string; mode: SheetMode } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [toast, showToast] = useAppToast();
  const requestRef = useRef(0);

  function load() {
    const requestId = ++requestRef.current;
    api
      .get<ReceptionBoardView>('/reception/board')
      .then((b) => {
        if (requestId !== requestRef.current) return;
        setBoard(b);
        setError(null);
        setNow(Date.now());
      })
      .catch(() => {
        if (requestId === requestRef.current) setError('Не удалось загрузить очередь');
      });
  }

  // Новые вопросы приходят сами — опрос, пока раздел открыт.
  useEffect(() => {
    if (!active) return;
    load();
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [active]);

  function conflict() {
    setSheet(null);
    setViewId(null);
    showToast('Очередь изменилась');
    load();
  }

  async function quick(item: ReceptionRequestItem, action: QuickAction) {
    setBusyId(item.id);
    try {
      await api.post(`/reception/requests/${item.id}/${action}`, { version: item.version }, { 'Idempotency-Key': crypto.randomUUID() });
      notificationHaptic('success');
      setViewId(null);
      showToast(action === 'call' ? `Позвали: ${item.author.fullName}` : action === 'move-to-end' ? 'В конце очереди' : 'Вернули в очередь');
      load();
    } catch (err) {
      notificationHaptic('error');
      if (isQueueChanged(err)) conflict();
      else {
        showToast(err instanceof ApiError ? err.message.replace(/^[A-Z_]+: /, '') : 'Не удалось выполнить действие');
        load();
      }
    } finally {
      setBusyId(null);
    }
  }

  const current = board?.current ?? null;
  // Наверху — вызванный; если никого не позвали, первый в очереди.
  const focus = current ?? board?.waiting[0] ?? null;
  const rest = (board?.waiting ?? []).filter((w) => w.id !== focus?.id);
  const todayKey = companyDayKey(new Date(now));
  const closedToday = board ? [...board.answered, ...board.delegated].filter((r) => r.closedAt && companyDayKey(r.closedAt) === todayKey).length : 0;
  const all = board ? [...(current ? [current] : []), ...board.waiting] : [];
  const viewed = all.find((r) => r.id === viewId) ?? null;
  const sheetItem = sheet ? (all.find((r) => r.id === sheet.id) ?? null) : null;

  return (
    <div>
      <ScreenHeader
        kicker={board ? `В очереди ${board.totalWaiting} · отвечено ${closedToday}` : undefined}
        title="Приёмная"
        action={board ? current ? <Pill tone="orange">Идёт приём</Pill> : <Pill tone="teal">Кабинет свободен</Pill> : undefined}
      />

      {error && <Alert tone="danger">{error}</Alert>}

      {!board && !error && (
        <div className="rcp-focus">
          <Skeleton height={18} width="50%" />
          <Skeleton height={16} width="85%" />
        </div>
      )}

      {board && !focus && <div className="attention-empty">Очередь пуста · отвечено {closedToday}</div>}

      {focus && (
        <>
          <article className="rcp-focus">
            <span className="kicker">{focus.status === 'CALLED' ? 'Сейчас у вас' : 'Следующий'}</span>
            <button type="button" className="rcp-focus-main" onClick={() => setViewId(focus.id)}>
              <span className="rcp-person">
                <Avatar id={focus.author.id} name={focus.author.fullName} size={44} />
                <span className="rcp-person-text">
                  <strong>{focus.author.fullName}</strong>
                  <span>{meta(focus)}</span>
                  <span className="rcp-wait">
                    {focus.status === 'CALLED' && focus.lastCalledAt
                      ? `вызван ${companyTime(focus.lastCalledAt)}`
                      : `ждёт ${waited(focus.createdAt, now)}`}
                  </span>
                </span>
              </span>
              <span className="rcp-focus-title">{focus.title}</span>
              {focus.description && <span className="rcp-focus-desc">{focus.description}</span>}
            </button>
            {focus.desiredBy && (
              <p className="rcp-deadline">
                Нужен ответ до {companyDate(focus.desiredBy)}, {companyTime(focus.desiredBy)}
                {focus.urgencyReason && ` — ${focus.urgencyReason}`}
              </p>
            )}
            {focus.status === 'CALLED' && current?.notificationStatus && NOTIFICATION_HINT[current.notificationStatus] && (
              <p className="ds-field-hint">{NOTIFICATION_HINT[current.notificationStatus]}</p>
            )}
          </article>
          <ReceptionActions
            item={focus}
            otherCalled={!!current && current.id !== focus.id}
            busy={busyId === focus.id}
            onQuick={(a) => void quick(focus, a)}
            onSheet={(mode) => setSheet({ id: focus.id, mode })}
          />
        </>
      )}

      {rest.length > 0 && (
        <>
          <SectionLabel>Дальше в очереди</SectionLabel>
          <div className="list-card">
            {rest.map((r, i) => (
              <button key={r.id} type="button" className="rcp-row" onClick={() => setViewId(r.id)}>
                <span className="rcp-row-pos">{i + (current ? 1 : 2)}</span>
                <span className="rcp-row-text">
                  <strong>{r.author.fullName}</strong>
                  <span>{r.title}</span>
                </span>
                <span className="due">{waited(r.createdAt, now)}</span>
              </button>
            ))}
          </div>
          {board && board.totalWaiting > board.waiting.length && (
            <p className="ds-field-hint">Ещё {board.totalWaiting - board.waiting.length} — в веб-версии.</p>
          )}
        </>
      )}

      {onOpenMine && (
        <>
          <SectionLabel>Разделы</SectionLabel>
          <div className="list-card">
            <button type="button" className="list-row" onClick={onOpenMine}>
              <span className="list-row-icon">
                <MessageSquare size={18} strokeWidth={1.75} />
              </span>
              <span className="list-row-label">Мои вопросы</span>
              <ChevronRight size={18} className="list-row-chevron" />
            </button>
          </div>
        </>
      )}

      {/* Вопрос целиком из очереди: текст, файлы и те же 4 действия. */}
      {viewed && !sheet && (
        <OverlayPortal>
          <Dialog sheet title={viewed.title} description={`${viewed.author.fullName} · ${meta(viewed)}`} onClose={() => setViewId(null)}>
            <div className="rcp-sheet">
              {viewed.description && <p className="rcp-sheet-question">{viewed.description}</p>}
              {viewed.attachments.length > 0 && <ReceptionAttachmentList requestId={viewed.id} attachments={viewed.attachments} />}
              {!!current && current.id !== viewed.id && <p className="ds-field-hint">Позвать можно после завершения текущего приёма.</p>}
              <ReceptionActions
                item={viewed}
                otherCalled={!!current && current.id !== viewed.id}
                busy={busyId === viewed.id}
                onQuick={(a) => void quick(viewed, a)}
                onSheet={(mode) => setSheet({ id: viewed.id, mode })}
              />
            </div>
          </Dialog>
        </OverlayPortal>
      )}

      {sheet && sheetItem && (
        <ReceptionSheet
          item={sheetItem}
          mode={sheet.mode}
          onClose={() => setSheet(null)}
          onConflict={conflict}
          onDone={(message) => {
            setSheet(null);
            setViewId(null);
            showToast(message);
            load();
          }}
        />
      )}
      {toast}
    </div>
  );
}
