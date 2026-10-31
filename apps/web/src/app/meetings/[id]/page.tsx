'use client';

import { use, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import { ArrowLeft, FileText, ListTodo, Users } from 'lucide-react';
import type { MeetingAnalysisState, MeetingDetail, MeetingSpeakerSuggestion } from '@ai-task-system/shared-types';
import { MANAGER_ROLES } from '@ai-task-system/shared-types';
import { api, ApiError } from '@/lib/api';
import { Protected } from '@/components/protected';
import { MeetingProposalsPanel } from '@/components/meetings/meeting-proposals-panel';
import { PageHeader } from '@/components/ui/card';
import { Panel, StatusTag } from '@/components/ui/panel';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { StatusBadge } from '@/components/ui/badge';
import { Chip } from '@/components/ui/chip';
import { Input } from '@/components/ui/field';
import { useAgentContext } from '@/components/agent-panel/agent-context';

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
  // Подсказки последнего разбора «Найти поручения» (шаг «говорящие»).
  // Без них форма работает как раньше — ошибка загрузки не показывается.
  const [suggestions, setSuggestions] = useState<MeetingSpeakerSuggestion[]>([]);

  useEffect(() => {
    api
      .get<{ run: MeetingAnalysisState | null }>(`/meetings/${meeting.id}/analysis`)
      .then(({ run }) => setSuggestions(run?.speakerSuggestions ?? []))
      .catch(() => setSuggestions([]));
  }, [meeting.id]);

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
    <Panel icon={Users} title="Спикеры">
      <p className="panel-hint">Впишите имена вместо номеров — саммари станет понятнее, а исполнители точнее.</p>
      <div className="meeting-speakers">
        {labels.map((label) => {
          // Подсказка — только пока поле пустое и имя не применено само:
          // вписанное человеком не перебиваем. «Верно» лишь заполняет
          // поле, сохраняет по-прежнему «Сохранить имена».
          const hint = suggestions.find((s) => s.label === label && s.name && !s.applied);
          const showHint = hint?.name && !(names[label] ?? '').trim();
          return (
            <div key={label}>
              <label className="ds-field-label">
                {label}
                <Input
                  value={names[label] ?? ''}
                  onChange={(e) => setNames((prev) => ({ ...prev, [label]: e.target.value }))}
                  placeholder="Имя"
                />
              </label>
              {showHint && (
                <p className="ds-field-hint">
                  Похоже, это {hint.name}{' '}
                  <Button variant="ghost" size="sm" onClick={() => setNames((prev) => ({ ...prev, [label]: hint.name ?? '' }))}>
                    Верно
                  </Button>
                </p>
              )}
            </div>
          );
        })}
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="panel-actions">
        <Button variant="secondary" size="sm" onClick={save} disabled={busy} loading={busy}>
          Сохранить имена
        </Button>
      </div>
    </Panel>
  );
}

function MeetingDetailView({ id }: { id: string }) {
  const [meeting, setMeeting] = useState<MeetingDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  function load() {
    api
      .get<MeetingDetail>(`/meetings/${id}`)
      .then(setMeeting)
      .catch(() => setError('Не удалось загрузить встречу'));
  }

  useEffect(load, [id]);
  useAgentContext(meeting ? { kind: 'meeting', id: meeting.id, label: meeting.title } : null);

  if (error) return <Alert tone="danger">{error}</Alert>;
  if (!meeting) return <p className="ds-field-hint">Загрузка…</p>;

  return (
    <div>
      <Link href="/meetings" className="back-link">
        <ArrowLeft size={14} strokeWidth={1.75} />
        Встречи
      </Link>
      <PageHeader
        kicker={`${new Date(meeting.meetingDate).toLocaleDateString('ru-RU')} · загрузил ${meeting.createdBy.fullName}`}
        title={meeting.title}
      />

      <div className="detail-grid">
        <Panel icon={FileText} title="Саммари" aside={!meeting.enhancedSummary && <StatusTag tone="muted">исходная версия</StatusTag>}>
          <div className="ds-md">
            {/* remark-gfm — чек-листы/таблицы из GFM-разметки Plaud; rehype-raw —
                встроенный HTML вроде <mark> в разделе "Задачи" саммари (владелец
                09.09.2026, источник — реальный сэмпл вывода Plaud). */}
            <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]}>
              {meeting.enhancedSummary ?? meeting.rawSummary}
            </ReactMarkdown>
          </div>
        </Panel>

        <div className="detail-col">
          {/* Поручения из встречи — разбор по кнопке, задачи только после
              утверждения (AGENT_AND_MEETINGS.md, B.5). Прежнюю модалку
              «Поставить задачи» панель заменила. */}
          <MeetingProposalsPanel meetingId={meeting.id} onMeetingChanged={load} />
          <Panel icon={ListTodo} title="Задачи из встречи" aside={meeting.tasks.length > 0 && <StatusTag tone="muted">{meeting.tasks.length}</StatusTag>}>
            {meeting.tasks.length === 0 ? (
              <p className="panel-hint">Пока ни одной — утвердите поручения выше.</p>
            ) : (
              <ul className="row-list">
                {meeting.tasks.map((t) => (
                  <li key={t.id} className="row-item">
                    <Link href={`/tasks/${t.id}`} className="row-item-title">
                      {t.title}
                    </Link>
                    <span className="row-item-side">
                      {t.sourceTimestamp && <Chip>{t.sourceTimestamp}</Chip>}
                      <StatusBadge status={t.status} />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          <SpeakerNamesSection meeting={meeting} onSaved={load} />
        </div>
      </div>
    </div>
  );
}

export default function MeetingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <Protected requireRole={MANAGER_ROLES}>
      <MeetingDetailView id={id} />
    </Protected>
  );
}
