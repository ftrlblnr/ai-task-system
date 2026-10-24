'use client';

import { useEffect, useState } from 'react';
import { MapPin } from 'lucide-react';
import type { DashboardEventItem, DashboardOverview, EmailListItem } from '@ai-task-system/shared-types';
import { api, ApiError } from '@/lib/api';
import { companyDate, companyDayKey, companyTime, formatDuration } from '@/lib/company-time';
import { notificationHaptic } from '@/lib/telegram';
import { Alert, Button, SectionLabel, Skeleton, StatTile, useAppToast } from '@/components/ui';
import { useAskAssistant, useOpenSection } from '../app-shell';
import { Avatar } from '../avatar';
import { TaskDetailOverlay } from '../task-detail-overlay';
import { AttentionStack, type AttentionItem } from './attention-stack';

// «Сегодня» руководителя (§4.2): ближайшая встреча, счётчики, «Требует вас»,
// быстрые вопросы ассистенту. Всё — из GET /dashboard/overview (каждый его
// раздел сам ok/error) и писем, ждущих ответа.

// Пока нет навыков (ARMS фазы 3–4) — готовые вопросы ассистенту, без чипа модели.
export const QUICK_PROMPTS = ['Что у меня важного сегодня?', 'Подготовь меня к ближайшей встрече', 'Разбери просрочки по исполнителям', 'Итоги недели'];

const MAIL_CARDS = 3;

export function OwnerToday({ active }: { active: boolean }) {
  const openSection = useOpenSection();
  const askAssistant = useAskAssistant();
  const [toast, showToast] = useAppToast();
  const [overview, setOverview] = useState<DashboardOverview | null>(null);
  const [mail, setMail] = useState<EmailListItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [callingId, setCallingId] = useState<string | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  // «Через N мин» пересчитываем раз в минуту, пока раздел открыт.
  const [now, setNow] = useState(() => Date.now());

  function load() {
    api
      .get<DashboardOverview>('/dashboard/overview')
      .then((data) => {
        setOverview(data);
        setError(null);
        setNow(Date.now());
      })
      .catch(() => setError('Не удалось загрузить сводку'));
    // Письма — по статусу переписки, а не по флагу ИИ needsReply: статус
    // учитывает, что вы уже ответили. Почта может быть не подключена — тогда
    // писем в стопке просто нет.
    api
      .get<{ items: EmailListItem[] }>('/mail/messages?replyStatus=AWAITING_MY_REPLY&limit=10')
      .then((res) => {
        const seen = new Set<string>();
        setMail(
          res.items
            .filter((m) => {
              const thread = m.threadId ?? m.id;
              if (seen.has(thread)) return false;
              seen.add(thread);
              return true;
            })
            .slice(0, MAIL_CARDS),
        );
      })
      .catch(() => setMail([]));
  }

  useEffect(() => {
    if (!active) return;
    load();
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, [active]);

  const tasks = overview?.tasks.status === 'ok' ? overview.tasks : null;
  const reception = overview?.reception.status === 'ok' ? overview.reception : null;
  const calendar = overview?.calendar.status === 'ok' ? overview.calendar : null;

  // Ближайшая встреча — первое ещё не закончившееся событие сегодняшнего дня.
  const todayKey = companyDayKey(new Date(now));
  const meeting = calendar?.items.find((e) => !e.allDay && new Date(e.endAt).getTime() > now && companyDayKey(e.startAt) === todayKey) ?? null;

  async function callVisitor(id: string, version: number, name: string) {
    setCallingId(id);
    try {
      await api.post(`/reception/requests/${id}/call`, { version }, { 'Idempotency-Key': crypto.randomUUID() });
      notificationHaptic('success');
      showToast(`Позвали: ${name}`);
    } catch (err) {
      notificationHaptic('error');
      const message = err instanceof ApiError ? err.message : '';
      // Версия разошлась — очередь успели поменять (другое устройство, web).
      if (err instanceof ApiError && err.status === 409 && !message.startsWith('RECEPTION_BUSY')) showToast('Очередь изменилась');
      else showToast(message.replace(/^[A-Z_]+: /, '') || 'Не удалось позвать');
    } finally {
      setCallingId(null);
      load();
    }
  }

  const attention: AttentionItem[] | null = overview
    ? [
        ...(reception && reception.items[0]
          ? [
              (() => {
                const r = reception.items[0];
                const waited = Math.max(0, Math.round((now - new Date(r.createdAt).getTime()) / 60_000));
                return {
                  key: `r:${r.id}`,
                  kicker: `Приёмная · ждёт ${formatDuration(waited)}`,
                  title: r.author.fullName,
                  text: r.title,
                  action: {
                    label: 'Позвать',
                    onClick: () => void callVisitor(r.id, r.version, r.author.fullName),
                    busy: callingId === r.id,
                    // Пока кто-то вызван, сервер второго не позовёт (RECEPTION_BUSY).
                    disabled: reception.current !== null,
                    hint: reception.current ? 'Сначала завершите текущий приём' : undefined,
                  },
                };
              })(),
            ]
          : []),
        ...mail.map((m) => {
          const from = m.fromName || m.fromAddress;
          const subject = m.subject || 'без темы';
          return {
            key: `m:${m.threadId ?? m.id}`,
            kicker: 'Письмо · ждёт ответа',
            title: from,
            text: subject,
            action: { label: 'Ответить', onClick: () => askAssistant(`Подготовь ответ на письмо «${subject}» от ${from}`) },
          };
        }),
        ...(tasks?.items ?? [])
          .filter((t) => t.isOverdue)
          .map((t) => ({
            key: `t:${t.id}`,
            kicker: t.dueDate ? `Задача · срок ${companyDate(t.dueDate)}` : 'Задача · просрочена',
            title: t.title,
            text: t.assignee ? `Исполнитель: ${t.assignee.fullName}` : 'Без исполнителя',
            action: { label: 'Открыть', onClick: () => setTaskId(t.id) },
          })),
      ]
    : null;

  return (
    <>
      {error && <Alert tone="danger">{error}</Alert>}

      {meeting && <MeetingCard meeting={meeting} now={now} onPrepare={() => askAssistant(`Подготовь меня к встрече «${meeting.title}» в ${companyTime(meeting.startAt)}`)} />}

      <div className="stat-grid">
        {overview ? (
          <>
            <StatTile value={tasks?.counts.active ?? '—'} label="Активные" onClick={() => openSection('tasks')} />
            <StatTile value={tasks?.counts.overdue ?? '—'} label="Просрочено" accent={(tasks?.counts.overdue ?? 0) > 0} onClick={() => openSection('tasks')} />
            <StatTile value={tasks?.counts.inReview ?? '—'} label="На проверке" onClick={() => openSection('tasks')} />
            <StatTile value={reception?.waitingCount ?? '—'} label="В приёмной" onClick={() => openSection('reception')} />
          </>
        ) : (
          [0, 1, 2, 3].map((i) => <Skeleton key={i} height={60} radius={16} />)
        )}
      </div>

      <SectionLabel>Требует вас</SectionLabel>
      <AttentionStack items={attention} />

      <SectionLabel>Спросить ассистента</SectionLabel>
      <div className="prompt-chips">
        {QUICK_PROMPTS.map((p) => (
          <button key={p} type="button" className="prompt-chip" onClick={() => askAssistant(p)}>
            {p}
          </button>
        ))}
      </div>

      {taskId && (
        <TaskDetailOverlay
          taskId={taskId}
          onClose={() => {
            setTaskId(null);
            load();
          }}
        />
      )}
      {toast}
    </>
  );
}

function MeetingCard({ meeting, now, onPrepare }: { meeting: DashboardEventItem; now: number; onPrepare: () => void }) {
  const start = new Date(meeting.startAt).getTime();
  const minutes = Math.round((start - now) / 60_000);
  const when = minutes > 0 ? `Через ${formatDuration(minutes)} · ${companyTime(meeting.startAt)}` : `Идёт сейчас · до ${companyTime(meeting.endAt)}`;

  return (
    <article className="meeting-card">
      <span className="kicker">Ближайшая встреча</span>
      <span className="meeting-when">{when}</span>
      <h3 className="meeting-title">{meeting.title}</h3>
      {meeting.location && (
        <span className="meeting-place">
          <MapPin size={14} strokeWidth={1.75} />
          {meeting.location}
        </span>
      )}
      <div className="meeting-footer">
        {meeting.participants.length > 0 && (
          <span className="meeting-people" aria-label={meeting.participants.map((p) => p.fullName).join(', ')}>
            {meeting.participants.slice(0, 4).map((p) => (
              <Avatar key={p.id} id={p.id} name={p.fullName} size={28} />
            ))}
            {meeting.participants.length > 4 && <span className="meeting-more">+{meeting.participants.length - 4}</span>}
          </span>
        )}
        <Button variant="primary" size="lg" className="meeting-prepare" onClick={onPrepare}>
          Подготовиться
        </Button>
      </div>
    </article>
  );
}
