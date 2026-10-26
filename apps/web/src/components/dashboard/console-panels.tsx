'use client';

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  CalendarDays,
  FileText,
  Files,
  Mail,
  Plus,
  Repeat,
  Search,
  Sparkles,
} from 'lucide-react';
import type {
  DashboardEventItem,
  DashboardFileItem,
  DashboardMailSection,
  DashboardRoutineItem,
  DashboardSkillItem,
  DashboardSkillsSection,
  RoutineRunStatus,
} from '@ai-task-system/shared-types';
import { EMAIL_CATEGORY_LABELS, ROUTINE_RUN_STATUS_LABELS } from '@ai-task-system/shared-types';
import { api } from '@/lib/api';
import { useSkillRun } from '@/app/skills/skill-ui';
import { Alert, ModelChip, Panel, RunButton, Skeleton, StatusTag, type StatusTone } from '@/components/ui';
import type { SectionState } from './use-dashboard-overview';

// Панели пульта руководителя (ARMS, фаза 6). Всё — данные из
// GET /dashboard/overview, без вызова модели; ▶ навыка — единственное, что
// тратит токены, и только по нажатию.

const TZ = 'Asia/Almaty';

export function time(iso: string): string {
  return new Date(iso).toLocaleTimeString('ru-RU', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
}

function dayTime(iso: string): string {
  const d = new Date(iso);
  const today = new Date().toLocaleDateString('ru-RU', { timeZone: TZ });
  const day = d.toLocaleDateString('ru-RU', { timeZone: TZ });
  return day === today ? time(iso) : `${d.toLocaleDateString('ru-RU', { timeZone: TZ, day: '2-digit', month: '2-digit' })} ${time(iso)}`;
}

function PanelBody<T>({ state, loading, children }: { state: SectionState<T>; loading: boolean; children: (data: T) => ReactNode }) {
  if (state.data) return <>{children(state.data)}</>;
  if (state.error) return <Alert tone="danger">{state.error}</Alert>;
  return loading ? <Skeleton height={72} /> : null;
}

// --- Календарь ----------------------------------------------------------------

function isOngoing(ev: DashboardEventItem): boolean {
  const now = Date.now();
  return new Date(ev.startAt).getTime() <= now && now <= new Date(ev.endAt).getTime();
}

export function CalendarPanel({ state, loading }: { state: SectionState<{ items: DashboardEventItem[] }>; loading: boolean }) {
  return (
    <Panel icon={CalendarDays} title="Календарь" href="/calendar">
      <PanelBody state={state} loading={loading}>
        {(data) =>
          data.items.length === 0 ? (
            <p className="console-empty">Встреч впереди нет</p>
          ) : (
            <ul className="console-list">
              {data.items.map((ev) => (
                <li key={ev.id}>
                  <Link href={`/calendar?event=${ev.id}`} className="console-row">
                    <span className="console-time ds-num">{ev.allDay ? 'весь день' : dayTime(ev.startAt)}</span>
                    <span className="console-row-title">{ev.title}</span>
                    {isOngoing(ev) && <StatusTag tone="next">сейчас</StatusTag>}
                  </Link>
                </li>
              ))}
            </ul>
          )
        }
      </PanelBody>
    </Panel>
  );
}

// --- Почта --------------------------------------------------------------------

export function MailPanel({ state, loading }: { state: SectionState<DashboardMailSection>; loading: boolean }) {
  return (
    <Panel icon={Mail} title="Почта" href="/mail">
      <PanelBody state={state} loading={loading}>
        {(data) =>
          !data.connected ? (
            <p className="console-empty">
              Почта не подключена — <Link href="/mail">подключить</Link>
            </p>
          ) : (
            <>
              <p className="console-lead">
                <span className="ds-num">{data.received24h}</span> за 24 часа
                {data.lastSyncedAt && <span className="console-muted"> · синхр. {time(data.lastSyncedAt)}</span>}
              </p>
              {data.mix.length > 0 && <MailMix mix={data.mix} />}
              {data.needsYou.length === 0 ? (
                <p className="console-empty">Ничего не ждёт ответа</p>
              ) : (
                <ul className="console-list">
                  {data.needsYou.map((m) => (
                    <li key={m.id}>
                      <Link href="/mail" className="console-row console-row-2" title={m.summary ?? undefined}>
                        <span className="console-time ds-num">{m.receivedAt ? dayTime(m.receivedAt) : ''}</span>
                        <span className="console-row-title">
                          <strong>{m.from}</strong>
                          <span className="console-muted">{m.subject || '(без темы)'}</span>
                        </span>
                        <StatusTag tone={m.importance === 'CRITICAL' ? 'danger' : m.needsReply ? 'next' : 'warn'}>
                          {m.importance === 'CRITICAL' ? 'срочно' : m.needsReply ? 'ответить' : 'важно'}
                        </StatusTag>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )
        }
      </PanelBody>
    </Panel>
  );
}

function MailMix({ mix }: { mix: DashboardMailSection['mix'] }) {
  const total = mix.reduce((n, m) => n + m.count, 0);
  return (
    <div className="console-mix">
      <div className="console-mix-bar" role="img" aria-label={mix.map((m) => `${EMAIL_CATEGORY_LABELS[m.category]}: ${m.count}`).join(', ')}>
        {mix.map((m, i) => (
          <span key={m.category} className={`console-mix-seg is-${i % 5}`} style={{ flexGrow: m.count / total }} />
        ))}
      </div>
      <ul className="console-mix-legend">
        {mix.slice(0, 4).map((m, i) => (
          <li key={m.category}>
            <span className={`console-mix-dot is-${i % 5}`} />
            {EMAIL_CATEGORY_LABELS[m.category]} <span className="ds-num">{m.count}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// --- Регламенты ---------------------------------------------------------------

const ROUTINE_TONE: Record<RoutineRunStatus | 'NEXT', StatusTone> = {
  NEXT: 'next',
  QUEUED: 'info',
  RUNNING: 'info',
  DONE: 'ok',
  SILENT: 'muted',
  SKIPPED_CAP: 'warn',
  FAILED: 'danger',
};

function routineLabel(item: DashboardRoutineItem): string {
  return item.status === 'NEXT' ? 'далее' : ROUTINE_RUN_STATUS_LABELS[item.status].toLowerCase();
}

export function RoutinesPanel({ state, loading }: { state: SectionState<{ items: DashboardRoutineItem[] }>; loading: boolean }) {
  return (
    <Panel icon={Repeat} title="Регламенты" href="/routines">
      <PanelBody state={state} loading={loading}>
        {(data) =>
          data.items.length === 0 ? (
            <p className="console-empty">
              Регламентов нет — <Link href="/routines">создать</Link>
            </p>
          ) : (
            <ul className="console-list">
              {data.items.map((r) => (
                <li key={r.id}>
                  <Link href={r.conversationId ? `/assistant?c=${r.conversationId}` : '/routines'} className="console-row">
                    <span className="console-time ds-num">{dayTime(r.at)}</span>
                    <span className="console-row-title">{r.title}</span>
                    <StatusTag tone={ROUTINE_TONE[r.status]}>{routineLabel(r)}</StatusTag>
                  </Link>
                </li>
              ))}
            </ul>
          )
        }
      </PanelBody>
    </Panel>
  );
}

// --- Навыки -------------------------------------------------------------------

function SkillTile({ skill }: { skill: DashboardSkillItem }) {
  const run = useSkillRun(skill.id);
  return (
    <li className="console-skill">
      <div className="console-skill-head">
        <Link href={`/skills/${skill.id}`} className="console-skill-title">
          {skill.title}
        </Link>
        <RunButton label={`Запустить /${skill.slug}`} busy={run.busy} onRun={() => void run.start()} />
      </div>
      <div className="console-skill-meta">
        <span className="console-muted">/{skill.slug}</span>
        <ModelChip model={skill.model} effort={skill.effort} />
      </div>
      {run.conversationId ? (
        <Link href={`/assistant?c=${run.conversationId}`} className="console-skill-result">
          Открыть результат →
        </Link>
      ) : (
        run.label && <span className="console-muted console-skill-result">{run.label}</span>
      )}
    </li>
  );
}

export function SkillsPanel({ state, loading }: { state: SectionState<DashboardSkillsSection>; loading: boolean }) {
  return (
    <Panel
      icon={Sparkles}
      title="Навыки"
      href="/skills"
      hrefLabel="Все"
      aside={
        <Link href="/skills?new=1" className="ds-panel-link" aria-label="Новый навык" title="Новый навык">
          <Plus size={14} strokeWidth={2} />
        </Link>
      }
    >
      <PanelBody state={state} loading={loading}>
        {(data) =>
          data.items.length === 0 ? (
            <p className="console-empty">Навыков нет</p>
          ) : (
            <ul className="console-skills">
              {data.items.map((s) => (
                <SkillTile key={s.id} skill={s} />
              ))}
            </ul>
          )
        }
      </PanelBody>
    </Panel>
  );
}

// --- Входящие файлы -----------------------------------------------------------

function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}

function extension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toUpperCase().slice(0, 4) : 'FILE';
}

async function download(file: DashboardFileItem) {
  const blob = await api.downloadBlob(`/files/${file.id}/download`);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function FilesStrip({ state, loading }: { state: SectionState<{ items: DashboardFileItem[]; total: number }>; loading: boolean }) {
  const [query, setQuery] = useState('');
  const [failed, setFailed] = useState<string | null>(null);
  const q = query.trim().toLowerCase();
  return (
    <Panel
      icon={Files}
      title="Входящие файлы"
      className="console-files"
      aside={
        state.data && state.data.items.length > 0 ? (
          <label className="console-files-search">
            <Search size={14} strokeWidth={1.75} />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Найти файл" aria-label="Найти файл" />
          </label>
        ) : undefined
      }
    >
      <span id="files" className="console-anchor" />
      <PanelBody state={state} loading={loading}>
        {(data) => {
          const shown = q ? data.items.filter((f) => f.name.toLowerCase().includes(q)) : data.items;
          if (data.items.length === 0) return <p className="console-empty">Здесь появятся файлы, которые подготовит ассистент: выгрузки, документы, отчёты</p>;
          if (shown.length === 0) return <p className="console-empty">Ничего не найдено</p>;
          return (
            <>
              {failed && <Alert tone="danger">{failed}</Alert>}
              <ul className="console-file-strip">
                {shown.map((f) => (
                  <li key={f.id}>
                    <button
                      type="button"
                      className="console-file"
                      title={f.name}
                      onClick={() => {
                        setFailed(null);
                        download(f).catch(() => setFailed(`Не удалось скачать «${f.name}»`));
                      }}
                    >
                      <span className="console-file-ext">
                        <FileText size={16} strokeWidth={1.75} />
                        {extension(f.name)}
                      </span>
                      <span className="console-file-name">{f.name}</span>
                      <span className="console-muted ds-num">
                        {dayTime(f.createdAt)} · {sizeText(f.size)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          );
        }}
      </PanelBody>
    </Panel>
  );
}

// --- Спросить агента ----------------------------------------------------------

export function AskAgent({ skills }: { skills: { id: string; slug: string; title: string }[] }) {
  const router = useRouter();
  const [text, setText] = useState('');
  const [active, setActive] = useState(0);
  const slash = /^\/(\S*)$/.exec(text);
  const suggestions = slash ? skills.filter((s) => s.slug.startsWith(slash[1].toLowerCase())).slice(0, 6) : [];

  function submit(value: string) {
    const q = value.trim();
    if (q) router.push(`/assistant?q=${encodeURIComponent(q)}`);
  }

  function pick(slug: string) {
    setText(`/${slug} `);
    setActive(0);
  }

  return (
    <form
      className="console-ask"
      onSubmit={(e) => {
        e.preventDefault();
        if (suggestions.length > 0) pick(suggestions[active]?.slug ?? suggestions[0].slug);
        else submit(text);
      }}
    >
      <Sparkles size={16} strokeWidth={1.75} />
      <input
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (suggestions.length === 0) return;
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((i) => (i + 1) % suggestions.length);
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((i) => (i - 1 + suggestions.length) % suggestions.length);
          }
        }}
        placeholder="Спросить агента… «/» — навыки"
        aria-label="Спросить агента"
        role="combobox"
        aria-expanded={suggestions.length > 0}
        aria-controls="console-ask-skills"
        aria-autocomplete="list"
      />
      <kbd className="console-kbd">Enter</kbd>
      {suggestions.length > 0 && (
        <ul className="console-ask-menu" id="console-ask-skills" role="listbox">
          {suggestions.map((s, i) => (
            <li key={s.id} role="option" aria-selected={i === active}>
              <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => pick(s.slug)}>
                <span className="ds-num">/{s.slug}</span>
                <span className="console-muted">{s.title}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </form>
  );
}
