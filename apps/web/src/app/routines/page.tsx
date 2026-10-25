'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { BellRing, History, Pause, Play, Plus, Repeat, Settings2, SunMedium } from 'lucide-react';
import type { RoutineInput, RoutineRunView, RoutinesOverview, RoutineView, SkillListItem } from '@ai-task-system/shared-types';
import { MANAGER_ROLES, ROUTINE_CHANNEL_LABELS, ROUTINE_MODE_LABELS, ROUTINE_RUN_STATUS_LABELS } from '@ai-task-system/shared-types';
import { api } from '@/lib/api';
import { Protected } from '@/components/protected';
import { Alert, Badge, Button, Card, EmptyState, IconButton, PageHeader, SegmentedControl, Select, Skeleton } from '@/components/ui';
import { DaysMark, errorText, RoutineForm, scheduleText, tokens, usd, useRoutineRun, WeekGrid } from './routine-ui';

// «Регламенты» (ARMS, фаза 4): поручения ассистенту по расписанию. Режим
// «Только важное» пишет, только если нашёл что-то важное. Внизу — системные
// кроны, только для обзора.

type Filter = 'ACTIVE' | 'MANUAL' | 'PAUSED' | 'ALL';
type Sort = 'time' | 'tokens' | 'cost';

const RUN_TONE: Record<RoutineRunView['status'], 'ok' | 'neutral' | 'warn' | 'danger' | 'info'> = {
  QUEUED: 'info',
  RUNNING: 'info',
  DONE: 'ok',
  SILENT: 'neutral',
  SKIPPED_CAP: 'warn',
  FAILED: 'danger',
};

function when(iso: string): string {
  return new Date(iso).toLocaleString('ru-RU', { timeZone: 'Asia/Almaty', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function RunRow({ run }: { run: RoutineRunView }) {
  return (
    <li className="routine-run">
      <Badge tone={RUN_TONE[run.status]}>{ROUTINE_RUN_STATUS_LABELS[run.status]}</Badge>
      <span className="ds-field-hint ds-num">
        {when(run.createdAt)}
        {run.trigger === 'BUTTON' ? ' · ▶' : ''}
        {run.tokens > 0 ? ` · ${tokens(run.tokens)} ток.` : ''}
      </span>
      {run.conversationId ? (
        <Link href={`/assistant?c=${run.conversationId}`} className="routine-run-text">
          {run.summary}
        </Link>
      ) : (
        <span className="routine-run-text">{run.summary ?? run.error}</span>
      )}
    </li>
  );
}

function RoutineCard({ routine, onChanged, onEdit }: { routine: RoutineView; onChanged: () => void; onEdit: () => void }) {
  const run = useRoutineRun(routine.id, onChanged);
  const [history, setHistory] = useState<RoutineRunView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const Icon = routine.mode === 'PASSIVE' ? BellRing : Repeat;
  const paused = routine.state === 'PAUSED';

  async function togglePause() {
    try {
      await api.patch(`/routines/${routine.id}`, { state: paused ? 'ACTIVE' : 'PAUSED' });
      onChanged();
    } catch (err) {
      setError(errorText(err, 'Не удалось сохранить'));
    }
  }

  function toggleHistory() {
    if (history) return setHistory(null);
    api
      .get<RoutineRunView[]>(`/routines/${routine.id}/runs`)
      .then(setHistory)
      .catch((err) => setError(errorText(err, 'Не удалось загрузить историю')));
  }

  const capShare = routine.weeklyTokenCap ? routine.week.tokens / routine.weeklyTokenCap : null;
  return (
    <article className={paused ? 'skill-card routine-card is-archived' : 'skill-card routine-card'}>
      <div className="skill-card-head">
        <span className="skill-card-icon" aria-hidden>
          <Icon size={18} strokeWidth={1.8} />
        </span>
        <span className="skill-slug">{routine.skill ? `/${routine.skill.slug}` : 'своя инструкция'}</span>
        {paused && <Badge tone="neutral">На паузе</Badge>}
      </div>
      <h3 className="skill-card-title">{routine.title}</h3>
      <div className="routine-when">
        <DaysMark days={routine.days} />
        <span className="ds-num">{routine.days ? routine.time : scheduleText(routine)}</span>
      </div>
      <p className="skill-card-desc">
        {ROUTINE_MODE_LABELS[routine.mode]} · {ROUTINE_CHANNEL_LABELS[routine.channel]}
      </p>
      <p className="ds-field-hint ds-num routine-stats">
        7 дней: {routine.week.runs} запуск. · {tokens(routine.week.tokens)} ток. · ≈{usd(routine.week.costUsd)}
        {capShare !== null && <span className={capShare >= 1 ? 'routine-cap is-over' : 'routine-cap'}> · лимит {Math.round(capShare * 100)}%</span>}
      </p>
      {error && <Alert tone="danger">{error}</Alert>}
      {history ? (
        <ul className="routine-runs">{history.length ? history.map((r) => <RunRow key={r.id} run={r} />) : <li className="ds-field-hint">Запусков ещё не было</li>}</ul>
      ) : (
        routine.lastRun && (
          <ul className="routine-runs">
            <RunRow run={routine.lastRun} />
          </ul>
        )
      )}
      <div className="skill-card-foot">
        <span className="ds-field-hint">{run.label ?? (routine.nextRunAt && !paused ? `Далее ${when(routine.nextRunAt)}` : '')}</span>
        <span className="ds-spacer" />
        <IconButton icon={Play} label="Запустить сейчас" size="sm" disabled={run.busy} onClick={() => void run.start()} />
        {routine.schedule && <IconButton icon={paused ? SunMedium : Pause} label={paused ? 'Возобновить' : 'Пауза'} size="sm" onClick={() => void togglePause()} />}
        <IconButton icon={History} label={history ? 'Скрыть историю' : 'История'} size="sm" onClick={toggleHistory} />
        <IconButton icon={Settings2} label="Изменить" size="sm" onClick={onEdit} />
      </div>
      {run.conversationId && (
        <Link href={`/assistant?c=${run.conversationId}`} className="skill-card-result">
          Открыть результат →
        </Link>
      )}
    </article>
  );
}

function Drafts({ drafts, onEnable, onEdit, onDelete }: { drafts: RoutineView[]; onEnable: (r: RoutineView) => void; onEdit: (r: RoutineView) => void; onDelete: (r: RoutineView) => void }) {
  return (
    <Card tone="agent" title="Предложено в чате" subtitle="Ассистент подготовил — включите, если всё верно">
      <ul className="routine-drafts">
        {drafts.map((r) => (
          <li key={r.id}>
            <div>
              <strong>{r.title}</strong>
              <span className="ds-field-hint">
                {scheduleText(r)} · {ROUTINE_MODE_LABELS[r.mode]} · {ROUTINE_CHANNEL_LABELS[r.channel]}
              </span>
            </div>
            <Button size="sm" variant="primary" onClick={() => onEnable(r)}>
              Включить
            </Button>
            <Button size="sm" variant="ghost" onClick={() => onEdit(r)}>
              Изменить
            </Button>
            <Button size="sm" variant="ghost" onClick={() => onDelete(r)}>
              Удалить
            </Button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function sortRoutines(list: RoutineView[], sort: Sort): RoutineView[] {
  const next = (r: RoutineView) => (r.nextRunAt && r.state === 'ACTIVE' ? Date.parse(r.nextRunAt) : Infinity);
  return [...list].sort((a, b) => (sort === 'tokens' ? b.week.tokens - a.week.tokens : sort === 'cost' ? b.week.costUsd - a.week.costUsd : next(a) - next(b)));
}

function RoutinesPage() {
  const [data, setData] = useState<RoutinesOverview | null>(null);
  const [skills, setSkills] = useState<SkillListItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('ACTIVE');
  const [sort, setSort] = useState<Sort>('time');
  // null — форма закрыта, 'new' — новый, иначе id редактируемого.
  const [editing, setEditing] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .get<RoutinesOverview>('/routines')
      .then((o) => {
        setData(o);
        setError(null);
      })
      .catch((err) => setError(errorText(err, 'Не удалось загрузить регламенты')));
  }, []);

  useEffect(load, [load]);
  useEffect(() => {
    api
      .get<SkillListItem[]>('/skills')
      .then(setSkills)
      .catch(() => setSkills([]));
  }, []);

  const all = data?.routines ?? [];
  const drafts = all.filter((r) => r.state === 'DRAFT');
  const live = all.filter((r) => r.state !== 'DRAFT');
  const shown = sortRoutines(
    live.filter((r) => (filter === 'ACTIVE' ? r.state === 'ACTIVE' && !!r.schedule : filter === 'MANUAL' ? !r.schedule : filter === 'PAUSED' ? r.state === 'PAUSED' : true)),
    sort,
  );
  const editingRoutine = editing && editing !== 'new' ? (all.find((r) => r.id === editing) ?? null) : null;

  async function save(input: Partial<RoutineInput>) {
    if (editingRoutine) await api.patch(`/routines/${editingRoutine.id}`, input);
    else await api.post('/routines', input);
    setEditing(null);
    load();
  }

  async function remove(r: RoutineView) {
    await api.delete(`/routines/${r.id}`);
    setEditing(null);
    load();
  }

  async function enable(r: RoutineView) {
    try {
      await api.patch(`/routines/${r.id}`, { state: 'ACTIVE' });
      load();
    } catch (err) {
      setError(errorText(err, 'Не удалось включить'));
    }
  }

  return (
    <div className="skills-page routines-page">
      <PageHeader
        title="Регламенты"
        description="Поручения ассистенту по расписанию. «Только важное» — пишет, только если нашёл то, что стоит знать сегодня."
        actions={
          !editing && (
            <Button variant="primary" icon={Plus} onClick={() => setEditing('new')}>
              Новый регламент
            </Button>
          )
        }
      />
      {error && <Alert tone="danger">{error}</Alert>}
      {editing && (
        <Card title={editingRoutine ? `Регламент «${editingRoutine.title}»` : 'Новый регламент'}>
          <RoutineForm
            key={editing}
            initial={editingRoutine}
            skills={skills}
            submitLabel={editingRoutine ? 'Сохранить' : 'Создать'}
            onSubmit={save}
            onCancel={() => setEditing(null)}
            onDelete={editingRoutine ? () => remove(editingRoutine) : undefined}
          />
        </Card>
      )}
      {drafts.length > 0 && !editing && <Drafts drafts={drafts} onEnable={(r) => void enable(r)} onEdit={(r) => setEditing(r.id)} onDelete={(r) => void remove(r).catch((err) => setError(errorText(err, 'Не удалось удалить')))} />}
      {!data && !error && <Skeleton height={200} />}
      {data && <WeekGrid routines={live} />}
      {data && live.length > 0 && (
        <div className="routine-toolbar">
          <SegmentedControl
            label="Показать"
            value={filter}
            onChange={(v) => setFilter(v as Filter)}
            options={[
              { value: 'ACTIVE', label: 'Активные' },
              { value: 'MANUAL', label: 'По кнопке' },
              { value: 'PAUSED', label: 'На паузе' },
              { value: 'ALL', label: 'Все' },
            ]}
          />
          <Select
            aria-label="Сортировка"
            className="routine-sort"
            value={sort}
            onChange={(e) => setSort(e.target.value as Sort)}
            options={[
              { value: 'time', label: 'По времени' },
              { value: 'tokens', label: 'По токенам' },
              { value: 'cost', label: 'По расходу' },
            ]}
          />
        </div>
      )}
      {data && shown.length === 0 && <EmptyState title={live.length === 0 ? 'Регламентов пока нет' : 'Здесь пусто'} description={live.length === 0 ? 'Создайте свой или попросите ассистента: «каждый понедельник в 9:00 присылай итоги недели».' : undefined} />}
      <div className="skill-deck">
        {shown.map((r) => (
          <RoutineCard key={r.id} routine={r} onChanged={load} onEdit={() => setEditing(r.id)} />
        ))}
      </div>
      {data && (
        <Card tone="sunken" title="Системные задачи" subtitle="Работают всегда, настраиваются в коде">
          <ul className="routine-system">
            {data.systemCrons.map((c) => (
              <li key={c.title}>
                <span>{c.title}</span>
                <span className="ds-field-hint">{c.schedule}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

export default function Page() {
  return (
    <Protected requireRole={MANAGER_ROLES}>
      <RoutinesPage />
    </Protected>
  );
}
