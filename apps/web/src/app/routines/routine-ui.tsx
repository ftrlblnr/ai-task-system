'use client';

import { useEffect, useRef, useState } from 'react';
import type { RoutineChannel, RoutineInput, RoutineMode, RoutineRunState, RoutineView, SkillListItem } from '@ai-task-system/shared-types';
import { ROUTINE_CHANNEL_LABELS, ROUTINE_MODE_LABELS, WEEKDAY_SHORT } from '@ai-task-system/shared-types';
import { api, ApiError } from '@/lib/api';
import { Alert, Button, Field, Input, Select, Textarea, cx } from '@/components/ui';

// Регламенты (ARMS, фаза 4): общее для страницы — форма, неделя, ▶.

export function errorText(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

export function usd(value: number): string {
  if (value === 0) return '$0';
  if (value < 0.01) return '<$0.01';
  return `$${value.toFixed(2)}`;
}

export function tokens(value: number): string {
  if (value < 1000) return String(value);
  return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)} тыс.`;
}

export function scheduleText(r: Pick<RoutineView, 'days' | 'time' | 'schedule'>): string {
  if (!r.schedule) return 'По кнопке';
  if (!r.days || !r.time) return `cron ${r.schedule}`;
  const days = r.days.length === 7 ? 'каждый день' : r.days.join(',') === '1,2,3,4,5' ? 'по будням' : r.days.map((d) => WEEKDAY_SHORT[d - 1]).join(', ');
  return `${days} в ${r.time}`;
}

const RUN_LABELS: Record<RoutineRunState['status'], string> = {
  QUEUED: 'В очереди…',
  RUNNING: 'Выполняется…',
  DONE: 'Готово',
  SILENT: 'Ничего важного',
  SKIPPED_CAP: 'Лимит исчерпан',
  FAILED: 'Не удалось',
};

// ▶: ставим прогон и опрашиваем, пока не закончится.
export function useRoutineRun(routineId: string, onDone: () => void) {
  const [run, setRun] = useState<RoutineRunState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const done = useRef(onDone);
  done.current = onDone;

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  function poll(id: string) {
    timer.current = setTimeout(() => {
      api
        .get<RoutineRunState>(`/routines/runs/${id}`)
        .then((r) => {
          setRun(r);
          if (r.status === 'QUEUED' || r.status === 'RUNNING') poll(id);
          else done.current();
        })
        .catch(() => poll(id));
    }, 3000);
  }

  async function start() {
    setError(null);
    try {
      const r = await api.post<RoutineRunState>(`/routines/${routineId}/run`, { clientRequestId: crypto.randomUUID() });
      setRun(r);
      poll(r.id);
    } catch (err) {
      setError(errorText(err, 'Не удалось запустить'));
    }
  }

  const busy = run?.status === 'QUEUED' || run?.status === 'RUNNING';
  const label = error ?? (run ? RUN_LABELS[run.status] : null);
  return { start, busy, label, conversationId: run?.status === 'DONE' ? run.conversationId : null };
}

export function DaysMark({ days }: { days: number[] | null }) {
  if (!days) return null;
  return (
    <span className="routine-days" aria-label={`Дни: ${days.map((d) => WEEKDAY_SHORT[d - 1]).join(', ')}`}>
      {WEEKDAY_SHORT.map((d, i) => (
        <span key={d} className={cx('routine-day', days.includes(i + 1) && 'is-on')} aria-hidden>
          {d}
        </span>
      ))}
    </span>
  );
}

// Неделя (Пн–Вс текущей недели по Алматы): что и когда запустится.
export function WeekGrid({ routines }: { routines: RoutineView[] }) {
  // День недели по Алматы — один раз при показе.
  const [today] = useState(() => new Date(Date.now() + 5 * 3600_000).getUTCDay() || 7);
  const scheduled = routines.filter((r) => r.state === 'ACTIVE' && r.days && r.time);
  if (scheduled.length === 0) return null;
  return (
    <div className="routine-week" role="table" aria-label="Неделя регламентов">
      {WEEKDAY_SHORT.map((label, i) => {
        const day = i + 1;
        const items = scheduled.filter((r) => r.days!.includes(day)).sort((a, b) => a.time!.localeCompare(b.time!));
        return (
          <div key={label} className={cx('routine-week-day', day === today && 'is-today')} role="row">
            <span className="routine-week-head" role="columnheader">
              {label}
            </span>
            {items.map((r) => (
              <span key={r.id} className={cx('routine-week-item', r.mode === 'PASSIVE' && 'is-passive')} role="cell" title={r.title}>
                <span className="ds-num">{r.time}</span> {r.title}
              </span>
            ))}
          </div>
        );
      })}
    </div>
  );
}

const MODES = Object.keys(ROUTINE_MODE_LABELS) as RoutineMode[];
const CHANNELS = Object.keys(ROUTINE_CHANNEL_LABELS) as RoutineChannel[];
const OWN = '__own__';

export function RoutineForm({
  initial,
  skills,
  submitLabel,
  onSubmit,
  onCancel,
  onDelete,
}: {
  initial: RoutineView | null;
  skills: SkillListItem[];
  submitLabel: string;
  onSubmit: (input: Partial<RoutineInput>) => Promise<void>;
  onCancel: () => void;
  onDelete?: () => Promise<void>;
}) {
  const [form, setForm] = useState<RoutineInput>(() => ({
    title: initial?.title ?? '',
    skillId: initial?.skill?.id ?? null,
    prompt: initial?.prompt ?? '',
    days: initial ? (initial.days ?? []) : [1, 2, 3, 4, 5],
    time: initial?.time ?? '09:00',
    mode: initial?.mode ?? 'PASSIVE',
    channel: initial?.channel ?? 'TELEGRAM',
    weeklyTokenCap: initial?.weeklyTokenCap ?? null,
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<RoutineInput>) => setForm((f) => ({ ...f, ...patch }));
  const own = !form.skillId;
  const valid = form.title.trim().length >= 2 && (own ? (form.prompt ?? '').trim().length >= 10 : true);
  const complexCron = !!initial?.schedule && !initial.days;

  function toggleDay(day: number) {
    set({ days: form.days.includes(day) ? form.days.filter((d) => d !== day) : [...form.days, day].sort((a, b) => a - b) });
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const payload: Partial<RoutineInput> = { ...form, prompt: own ? form.prompt : null, skillId: own ? null : form.skillId };
      // Сложный cron (не из формы) не трогаем, пока не выбраны дни.
      if (complexCron && form.days.length === 0) {
        delete payload.days;
        delete payload.time;
      }
      await onSubmit(payload);
    } catch (err) {
      setError(errorText(err, 'Не удалось сохранить'));
      setBusy(false);
    }
  }

  return (
    <form
      className="routine-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="routine-form-row">
        <Field label="Название">
          <Input value={form.title} onChange={(e) => set({ title: e.target.value })} placeholder="Письма без ответа" maxLength={80} autoFocus={!initial} />
        </Field>
        <Field label="Что делать">
          <Select
            value={form.skillId ?? OWN}
            onChange={(e) => set({ skillId: e.target.value === OWN ? null : e.target.value })}
            options={[{ value: OWN, label: 'Своя инструкция' }, ...skills.filter((s) => s.enabled).map((s) => ({ value: s.id, label: `/${s.slug} — ${s.title}` }))]}
          />
        </Field>
      </div>
      {own && (
        <Field label="Инструкция">
          <Textarea
            value={form.prompt ?? ''}
            onChange={(e) => set({ prompt: e.target.value })}
            rows={5}
            placeholder="Найди письма от ключевых контрагентов без ответа больше двух дней. Важно — если ждут решения или денег."
          />
        </Field>
      )}
      <div className="routine-form-row">
        <div className="ds-field">
          <span className="ds-field-label">Дни</span>
          <div className="routine-day-picker" role="group" aria-label="Дни недели">
            {WEEKDAY_SHORT.map((d, i) => (
              <button key={d} type="button" className={cx('routine-day-toggle', form.days.includes(i + 1) && 'is-on')} aria-pressed={form.days.includes(i + 1)} onClick={() => toggleDay(i + 1)}>
                {d}
              </button>
            ))}
          </div>
          <span className="ds-field-hint">{complexCron && form.days.length === 0 ? `Сейчас: cron ${initial.schedule}` : form.days.length === 0 ? 'Без дней — только по кнопке' : ' '}</span>
        </div>
        <Field label="Время (Алматы)">
          <Input type="time" value={form.time} onChange={(e) => set({ time: e.target.value })} disabled={form.days.length === 0} />
        </Field>
      </div>
      <div className="routine-form-row">
        <Field label="Когда присылать">
          <Select value={form.mode} onChange={(e) => set({ mode: e.target.value as RoutineMode })} options={MODES.map((m) => ({ value: m, label: ROUTINE_MODE_LABELS[m] }))} />
        </Field>
        <Field label="Куда">
          <Select value={form.channel} onChange={(e) => set({ channel: e.target.value as RoutineChannel })} options={CHANNELS.map((c) => ({ value: c, label: ROUTINE_CHANNEL_LABELS[c] }))} />
        </Field>
        <Field label="Лимит токенов в неделю">
          <Input
            type="number"
            min={0}
            step={10000}
            value={form.weeklyTokenCap ?? ''}
            placeholder="без лимита"
            onChange={(e) => set({ weeklyTokenCap: e.target.value ? Number(e.target.value) : null })}
          />
        </Field>
      </div>
      <div className="routine-form-actions">
        <Button type="submit" variant="primary" disabled={!valid || busy} loading={busy}>
          {submitLabel}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Отмена
        </Button>
        {onDelete && (
          <Button
            type="button"
            variant="ghost"
            className="routine-delete"
            disabled={busy}
            onClick={() => {
              if (window.confirm('Удалить регламент вместе с историей запусков?')) void onDelete().catch((err) => setError(errorText(err, 'Не удалось удалить')));
            }}
          >
            Удалить
          </Button>
        )}
      </div>
    </form>
  );
}
