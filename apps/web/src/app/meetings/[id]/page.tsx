'use client';

import { use, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import { ArrowLeft, ListTodo, Mic } from 'lucide-react';
import type { MeetingDetail } from '@ai-task-system/shared-types';
import { api, ApiError } from '@/lib/api';
import { Protected } from '@/components/protected';
import { STATUS_LABELS } from '@/lib/labels';
import { TaskExtractionModal } from '@/components/task-extraction-modal';

// "Speaker 1", "Speaker 2" — метки Plaud до сопоставления с реальными
// именами (владелец 09.09.2026). Дедуплицируем, сортируем по номеру.
function extractSpeakerLabels(text: string): string[] {
  const found = new Set(text.match(/\bSpeaker \d+\b/g) ?? []);
  return [...found].sort((a, b) => Number(a.split(' ')[1]) - Number(b.split(' ')[1]));
}

function SpeakerNamesSection({ meeting, onSaved }: { meeting: MeetingDetail; onSaved: () => void }) {
  const labels = useMemo(() => extractSpeakerLabels(meeting.rawSummary), [meeting.rawSummary]);
  const [names, setNames] = useState<Record<string, string>>(meeting.speakerNames ?? {});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Подстройка state под изменившийся проп (сохранение имён вызывает
  // onSaved → родитель перезагружает meeting) — по рекомендованному React-
  // паттерну (react.dev/learn/you-might-not-need-an-effect#adjusting-some-
  // state-when-a-prop-changes) делается прямо в рендере, не в useEffect
  // (аудит 10.09.2026, п. 5.2, первый реальный прогон lint в CI: react-
  // hooks/set-state-in-effect на прежнем useEffect(() => setNames(...))).
  const [syncedSpeakerNames, setSyncedSpeakerNames] = useState(meeting.speakerNames);
  if (meeting.speakerNames !== syncedSpeakerNames) {
    setSyncedSpeakerNames(meeting.speakerNames);
    setNames(meeting.speakerNames ?? {});
  }

  if (labels.length === 0) return null;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.patch(`/meetings/${meeting.id}/speakers`, { speakerNames: names });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось сохранить имена');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h2>Спикеры</h2>
      <p className="hint" style={{ marginBottom: 14 }}>
        Саммари ссылается на спикеров по номеру — впишите реальные имена, чтобы саммари стало понятнее
        и AI точнее определял исполнителя при постановке задач.
      </p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 14 }}>
        {labels.map((label) => (
          <label key={label} style={{ minWidth: 200 }}>
            {label}
            <input
              value={names[label] ?? ''}
              onChange={(e) => setNames((prev) => ({ ...prev, [label]: e.target.value }))}
              placeholder="Имя"
            />
          </label>
        ))}
      </div>
      {error && <p className="error">{error}</p>}
      <button className="btn-secondary btn-small" onClick={save} disabled={busy}>
        {busy ? 'Сохраняем…' : 'Сохранить имена'}
      </button>
    </div>
  );
}

function MeetingDetailView({ id }: { id: string }) {
  const [meeting, setMeeting] = useState<MeetingDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showExtraction, setShowExtraction] = useState(false);

  function load() {
    api
      .get<MeetingDetail>(`/meetings/${id}`)
      .then(setMeeting)
      .catch(() => setError('Не удалось загрузить встречу'));
  }

  useEffect(load, [id]);

  if (error) return <p className="error">{error}</p>;
  if (!meeting) return <p className="hint">Загрузка…</p>;

  return (
    <div>
      <Link href="/meetings" className="back-link">
        <ArrowLeft size={14} strokeWidth={2.25} />
        Встречи
      </Link>
      <div className="page-header">
        <h1>{meeting.title}</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link href={`/voice?meetingId=${meeting.id}`} className="btn-secondary">
            <Mic size={16} strokeWidth={2.25} />
            Голосом
          </Link>
          <button onClick={() => setShowExtraction(true)}>
            <ListTodo size={16} strokeWidth={2.25} />
            Поставить задачи
          </button>
        </div>
      </div>
      <div className="task-meta">
        <span className="badge badge-muted">{new Date(meeting.meetingDate).toLocaleDateString('ru-RU')}</span>
        <span className="badge badge-muted">Загрузил: {meeting.createdBy.fullName}</span>
      </div>

      <div className="card">
        <h2>Саммари</h2>
        {!meeting.enhancedSummary && (
          <p className="hint" style={{ marginBottom: 12 }}>
            Показана исходная версия из Plaud. Впишите имена спикеров ниже, если они есть в тексте.
          </p>
        )}
        <div className="reader-text">
          {/* remark-gfm — чек-листы/таблицы из GFM-разметки Plaud; rehype-raw —
              встроенный HTML вроде <mark> в разделе "Задачи" саммари (владелец
              09.09.2026, источник — реальный сэмпл вывода Plaud). */}
          <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]}>
            {meeting.enhancedSummary ?? meeting.rawSummary}
          </ReactMarkdown>
        </div>
      </div>

      <SpeakerNamesSection meeting={meeting} onSaved={load} />

      <div className="card">
        <h2>Задачи из этой встречи</h2>
        {meeting.tasks.length === 0 && (
          <p className="hint">Пока не привязано ни одной задачи — нажмите «Поставить задачи» выше или создайте задачу вручную и укажите эту встречу источником.</p>
        )}
        <ul className="plain-list">
          {meeting.tasks.map((t) => (
            <li key={t.id} className="plain-list-row">
              <Link href={`/tasks/${t.id}`}>{t.title}</Link>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                {t.sourceTimestamp && <span className="chip mono">{t.sourceTimestamp}</span>}
                <span className={`badge status-${t.status.toLowerCase()}`}>{STATUS_LABELS[t.status]}</span>
              </div>
            </li>
          ))}
        </ul>
      </div>

      {showExtraction && (
        <TaskExtractionModal
          meetingId={meeting.id}
          onClose={() => setShowExtraction(false)}
          onCreated={load}
        />
      )}
    </div>
  );
}

export default function MeetingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <Protected requireRole="OWNER">
      <MeetingDetailView id={id} />
    </Protected>
  );
}
