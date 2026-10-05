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
import { TaskExtractionModal } from '@/components/task-extraction-modal';
import { Card, PageHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { Chip } from '@/components/ui/chip';
import { Input } from '@/components/ui/field';

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
    <Card title="Спикеры">
      <p className="ds-field-hint" style={{ marginBottom: 14 }}>
        Саммари ссылается на спикеров по номеру — впишите реальные имена, чтобы саммари стало понятнее
        и AI точнее определял исполнителя при постановке задач.
      </p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 14 }}>
        {labels.map((label) => (
          <label key={label} style={{ minWidth: 200 }} className="ds-field-label">
            {label}
            <Input
              value={names[label] ?? ''}
              onChange={(e) => setNames((prev) => ({ ...prev, [label]: e.target.value }))}
              placeholder="Имя"
            />
          </label>
        ))}
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      <Button variant="secondary" size="sm" onClick={save} disabled={busy} loading={busy}>
        Сохранить имена
      </Button>
    </Card>
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

  if (error) return <Alert tone="danger">{error}</Alert>;
  if (!meeting) return <p className="ds-field-hint">Загрузка…</p>;

  return (
    <div>
      <Link href="/meetings" className="back-link">
        <ArrowLeft size={14} strokeWidth={1.75} />
        Встречи
      </Link>
      <PageHeader
        title={meeting.title}
        actions={
          <div style={{ display: 'flex', gap: 8 }}>
            <Link href={`/voice?meetingId=${meeting.id}`} className="ds-btn ds-btn-secondary">
              <Mic size={18} strokeWidth={1.75} />
              Голосом
            </Link>
            <Button variant="primary" icon={ListTodo} onClick={() => setShowExtraction(true)}>
              Поставить задачи
            </Button>
          </div>
        }
      />
      <div className="task-meta">
        <Badge>{new Date(meeting.meetingDate).toLocaleDateString('ru-RU')}</Badge>
        <Badge>Загрузил: {meeting.createdBy.fullName}</Badge>
      </div>

      <Card title="Саммари">
        {!meeting.enhancedSummary && (
          <p className="ds-field-hint" style={{ marginBottom: 12 }}>
            Показана исходная версия из Plaud. Впишите имена спикеров ниже, если они есть в тексте.
          </p>
        )}
        <div className="ds-md">
          {/* remark-gfm — чек-листы/таблицы из GFM-разметки Plaud; rehype-raw —
              встроенный HTML вроде <mark> в разделе "Задачи" саммари (владелец
              09.09.2026, источник — реальный сэмпл вывода Plaud). */}
          <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]}>
            {meeting.enhancedSummary ?? meeting.rawSummary}
          </ReactMarkdown>
        </div>
      </Card>

      <SpeakerNamesSection meeting={meeting} onSaved={load} />

      <Card title="Задачи из этой встречи">
        {meeting.tasks.length === 0 && (
          <p className="ds-field-hint">Пока не привязано ни одной задачи — нажмите «Поставить задачи» выше или создайте задачу вручную и укажите эту встречу источником.</p>
        )}
        <ul className="plain-list">
          {meeting.tasks.map((t) => (
            <li key={t.id} className="plain-list-row">
              <Link href={`/tasks/${t.id}`}>{t.title}</Link>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                {t.sourceTimestamp && <Chip>{t.sourceTimestamp}</Chip>}
                <StatusBadge status={t.status} />
              </div>
            </li>
          ))}
        </ul>
      </Card>

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
