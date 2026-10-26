'use client';

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { BarChart3, FileText, Files, Mail, Plus, Repeat, Search, Sparkles } from 'lucide-react';
import type {
  DashboardFileItem,
  DashboardMailSection,
  DashboardRoutineItem,
  DashboardSkillItem,
  DashboardSkillsSection,
  DashboardUsageSection,
  RoutineRunStatus,
} from '@ai-task-system/shared-types';
import { EMAIL_CATEGORY_LABELS, ROUTINE_RUN_STATUS_LABELS } from '@ai-task-system/shared-types';
import { api } from '@/lib/api';
import { useSkillRun } from '@/app/skills/skill-ui';
import { Alert, ModelChip, Panel, RunButton, Skeleton, StatusTag, cx, type StatusTone } from '@/components/ui';
import type { SectionState } from './use-dashboard-overview';
import { dayTime, span, tokens, usd } from './format';

// Секции пульта (ARMS, фаза 6; раскладка — редизайн web W5, §4.3). Всё —
// данные из GET /dashboard/overview, без вызова модели; ▶ навыка —
// единственное, что тратит токены, и только по нажатию.

function PanelBody<T>({ state, loading, children }: { state: SectionState<T>; loading: boolean; children: (data: T) => ReactNode }) {
  if (state.data) return <>{children(state.data)}</>;
  if (state.error) return <Alert tone="danger">{state.error}</Alert>;
  return loading ? <Skeleton height={72} /> : null;
}

// --- Почта --------------------------------------------------------------------

// «Ждут ответа» — те же письма, что с тегом «Ответ» в «Разборе»; строки —
// первые письма очереди разбора, клик открывает письмо там.
export function MailPanel({ state, loading, now }: { state: SectionState<DashboardMailSection>; loading: boolean; now: number }) {
  return (
    <Panel icon={Mail} title="Почта" aside={state.data?.lastSyncedAt ? <span className="console-muted pult-meta">синхр. {dayTime(state.data.lastSyncedAt, now)}</span> : undefined}>
      <PanelBody state={state} loading={loading}>
        {(data) =>
          !data.connected ? (
            <p className="console-empty">
              Почта не подключена — <Link href="/mail">подключить</Link>
            </p>
          ) : (
            <>
              <p className="pult-mail-lead">
                <span className="pult-mail-count ds-num">{data.needsReply}</span>
                <span>ждут вашего ответа · {data.received24h} за сутки</span>
              </p>
              {data.mix.length > 0 && <MailMix mix={data.mix} />}
              {data.top.length > 0 && (
                <ul className="console-list">
                  {data.top.map((m) => (
                    <li key={m.id}>
                      <Link href={`/mail?message=${m.id}`} className="pult-mail-row">
                        <span className={cx('pult-mail-dot', (m.importance === 'CRITICAL' || m.importance === 'IMPORTANT') && 'is-hot')} aria-hidden="true" />
                        <span className="pult-mail-text">
                          <span className="pult-mail-subject">{m.subject || '(без темы)'}</span>
                          <span className="console-muted pult-mail-from">{m.from}</span>
                        </span>
                        {m.receivedAt && <span className="console-muted pult-meta">{span(new Date(m.receivedAt).getTime(), now)}</span>}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
              <Link href="/mail" className="ds-btn ds-btn-secondary pult-mail-go">
                {data.top.length > 0 ? 'Разобрать почту →' : 'Открыть почту →'}
              </Link>
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

export function RoutinesPanel({ state, loading, now }: { state: SectionState<{ items: DashboardRoutineItem[] }>; loading: boolean; now: number }) {
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
                    <span className="console-time ds-num">{dayTime(r.at, now)}</span>
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

// --- Готовые файлы и расход ИИ ----------------------------------------------

const FILES_SHOWN = 6;

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

// Последние файлы, подготовленные ассистентом; поиск по имени — на клиенте,
// без модели, среди загруженных. Внизу — расход ИИ за сегодня.
export function FilesPanel({
  state,
  usage,
  loading,
  now,
}: {
  state: SectionState<{ items: DashboardFileItem[]; total: number }>;
  usage: SectionState<DashboardUsageSection>;
  loading: boolean;
  now: number;
}) {
  const [query, setQuery] = useState('');
  const [failed, setFailed] = useState<string | null>(null);
  const q = query.trim().toLowerCase();
  return (
    <Panel icon={Files} title="Готовые файлы" className="pult-files">
      <PanelBody state={state} loading={loading}>
        {(data) => {
          if (data.items.length === 0) return <p className="console-empty">Здесь появятся файлы, которые подготовит ассистент: выгрузки, документы, отчёты</p>;
          const shown = (q ? data.items.filter((f) => f.name.toLowerCase().includes(q)) : data.items).slice(0, FILES_SHOWN);
          return (
            <>
              <label className="pult-files-search">
                <Search size={14} strokeWidth={1.75} />
                <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Найти файл" aria-label="Найти файл" />
              </label>
              {failed && <Alert tone="danger">{failed}</Alert>}
              {shown.length === 0 ? (
                <p className="console-empty">Ничего не найдено</p>
              ) : (
                <ul className="pult-file-list">
                  {shown.map((f) => (
                    <li key={f.id}>
                      <button
                        type="button"
                        className="pult-file"
                        title={`${f.name} · ${sizeText(f.size)}`}
                        onClick={() => {
                          setFailed(null);
                          download(f).catch(() => setFailed(`Не удалось скачать «${f.name}»`));
                        }}
                      >
                        <span className="pult-file-ext">
                          <FileText size={13} strokeWidth={1.9} />
                          {extension(f.name)}
                        </span>
                        <span className="pult-file-name">{f.name}</span>
                        <span className="console-muted pult-meta">{dayTime(f.createdAt, now)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          );
        }}
      </PanelBody>
      {usage.data && <UsageToday usage={usage.data} />}
    </Panel>
  );
}

function UsageToday({ usage }: { usage: DashboardUsageSection }) {
  const cache = usage.week.cacheShare;
  return (
    <Link href="/ai-usage" className="pult-usage" title="Расход ИИ">
      <span className="pult-usage-head">
        <span className="section-kicker">
          <BarChart3 size={12} strokeWidth={2} /> Расход ИИ · сегодня
        </span>
        <span className="ds-num pult-usage-cost">≈ {usd(usage.today.costUsd)}</span>
      </span>
      {cache !== null && (
        <span className="pult-usage-bar" role="img" aria-label={`Кэш ${Math.round(cache * 100)}%`}>
          <span style={{ width: `${Math.round(cache * 100)}%` }} />
        </span>
      )}
      <span className="console-muted pult-meta">
        {tokens(usage.today.tokens)} ток.{cache !== null && ` · кэш ${Math.round(cache * 100)}%`} · неделя ≈ {usd(usage.week.costUsd)}
      </span>
    </Link>
  );
}
