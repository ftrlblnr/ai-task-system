'use client';

import { useEffect, useState } from 'react';
import type { AiUsageGroupBy, AiUsageRow, AiUsageSummary } from '@ai-task-system/shared-types';
import { MANAGER_ROLES } from '@ai-task-system/shared-types';
import { api } from '@/lib/api';
import { Protected } from '@/components/protected';
import { Alert, Badge, Card, EmptyState, PageHeader, SegmentedControl, Skeleton } from '@/components/ui';

// «Расход ИИ» (ARMS, фаза 2) — сколько стоит каждая функция и где не
// работает кэш. Данные — журнал AiCall (GET /ai-usage/summary), стоимость —
// оценка по таблице цен на сервере.

type SortKey = 'cost' | 'calls' | 'tokens' | 'perCall';

const FEATURE_LABELS: Record<string, string> = {
  'assistant.reply': 'Ассистент — ответы',
  'mail.analysis': 'Почта — разбор писем',
  'mail.action-analysis': 'Почта — план действий',
  'voice.draft-extraction': 'Голос — разбор команды',
  'voice.live_transcription': 'Голос — живая расшифровка',
  stt: 'Голос — расшифровка записи',
  'live.connect': 'Живой голос — подключение',
  'live.client': 'Живой голос — замер в браузере',
  'reception.answer-structuring': 'Приёмная — оформление ответа',
  'meetings.task-extraction': 'Встречи — задачи из встречи',
  'meetings.speaker-substitution': 'Встречи — имена спикеров',
  'trips.extraction': 'Поездки — разбор документов',
  'legal.ask': 'Юрист — вопрос по НПА',
  'legal.review': 'Юрист — разбор договора',
};

const MODEL_LABELS: Record<string, string> = {
  'claude-haiku-5-5': 'Claude Haiku 5.5',
  'claude-sonnet-5-5': 'Claude Sonnet 5.5',
  'claude-opus-5-5': 'Claude Opus 5.5',
  'claude-opus-5': 'Claude Opus 5',
};

// Кэш «не работает», если вход заметный, а из кэша почти ничего: порог,
// с которого кэширование окупается, — примерно 1–2 тыс. токенов на вызов.
const CACHE_WARN_MIN_INPUT_PER_CALL = 2000;
const CACHE_WARN_SHARE = 0.1;

function label(groupBy: AiUsageGroupBy, key: string): string {
  return (groupBy === 'model' ? MODEL_LABELS : FEATURE_LABELS)[key] ?? key;
}

function usd(value: number): string {
  if (value === 0) return '$0';
  if (value < 0.01) return '<$0.01';
  return `$${value.toFixed(value < 10 ? 2 : 0)}`;
}

function tokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)} млн`;
  if (value >= 1000) return `${Math.round(value / 1000)} тыс.`;
  return String(value);
}

function seconds(ms: number | null): string {
  return ms === null ? '—' : `${(ms / 1000).toFixed(1)} с`;
}

function percent(share: number | null): string {
  return share === null ? '—' : `${Math.round(share * 100)}%`;
}

function promptTokens(r: { inputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }) {
  return r.inputTokens + r.cacheReadTokens + r.cacheWriteTokens;
}

function cacheIdle(r: AiUsageRow): boolean {
  const priced = r.calls - r.unpricedCalls;
  return priced > 0 && promptTokens(r) / priced >= CACHE_WARN_MIN_INPUT_PER_CALL && (r.cacheShare ?? 0) < CACHE_WARN_SHARE;
}

function sortValue(r: AiUsageRow, key: SortKey): number {
  if (key === 'calls') return r.calls;
  if (key === 'tokens') return promptTokens(r) + r.outputTokens;
  if (key === 'perCall') return r.costPerCallUsd ?? 0;
  return r.costUsd;
}

function daysAgo(value: string): string {
  const days = Math.floor((Date.now() - new Date(value).getTime()) / 86_400_000);
  return `${days} дн. назад`;
}

function Stat({ label: title, value, hint }: { label: string; value: string | null; hint: string }) {
  return (
    <div className="ds-card usage-stat">
      <span className="ds-field-hint">{title}</span>
      {value === null ? <Skeleton width={90} height={34} /> : <span className="ds-num usage-stat-value">{value}</span>}
      <span className="ds-field-hint">{hint}</span>
    </div>
  );
}

function UsageRow({ row, groupBy, sort, max }: { row: AiUsageRow; groupBy: AiUsageGroupBy; sort: SortKey; max: number }) {
  const value = sortValue(row, sort);
  const priced = row.calls - row.unpricedCalls;
  return (
    <li className="usage-row">
      <div className="usage-row-head">
        <strong>{label(groupBy, row.key)}</strong>
        {cacheIdle(row) && <Badge tone="warn">кэш не работает</Badge>}
        {row.errors > 0 && <Badge tone="danger">ошибок: {row.errors}</Badge>}
        <span className="usage-row-cost ds-num">{priced > 0 ? usd(row.costUsd) : 'без оценки'}</span>
      </div>
      <div className="usage-bar" aria-hidden="true">
        <span style={{ width: `${max > 0 ? Math.max(1, (value / max) * 100) : 0}%` }} />
      </div>
      <div className="usage-row-meta ds-num">
        <span>{row.calls} выз.</span>
        {priced > 0 && <span>{usd(row.costPerCallUsd ?? 0)} за вызов</span>}
        {promptTokens(row) + row.outputTokens > 0 && (
          <span>
            {tokens(promptTokens(row))} вход · {tokens(row.outputTokens)} выход
          </span>
        )}
        {row.cacheShare !== null && <span>кэш {percent(row.cacheShare)}</span>}
        {row.audioSeconds > 0 && <span>аудио {Math.round(row.audioSeconds / 60)} мин</span>}
        <span>
          {seconds(row.p50LatencyMs)} / p95 {seconds(row.p95LatencyMs)}
        </span>
      </div>
    </li>
  );
}

function AiUsagePage() {
  const [days, setDays] = useState<'7' | '30'>('7');
  const [groupBy, setGroupBy] = useState<AiUsageGroupBy>('feature');
  const [sort, setSort] = useState<SortKey>('cost');
  const [data, setData] = useState<AiUsageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get<AiUsageSummary>(`/ai-usage/summary?days=${days}&groupBy=${groupBy}`)
      .then((s) => {
        if (cancelled) return;
        setData(s);
        setError(null);
      })
      .catch(() => !cancelled && setError('Не удалось загрузить расход'));
    return () => {
      cancelled = true;
    };
  }, [days, groupBy]);

  const shown = data && data.days === Number(days) && data.groupBy === groupBy ? data : null;
  const rows = shown ? [...shown.rows].sort((a, b) => sortValue(b, sort) - sortValue(a, sort)) : [];
  const max = rows.length ? Math.max(...rows.map((r) => sortValue(r, sort))) : 0;
  const total = shown?.total;
  const dayMax = shown ? Math.max(...shown.daily.map((d) => d.costUsd)) : 0;

  return (
    <div className="usage-page">
      <PageHeader
        title="Расход ИИ"
        description={
          shown
            ? `Оценка по ценам на ${new Date(shown.pricesAsOf).toLocaleDateString('ru-RU')}; точная сумма — в консоли Anthropic.`
            : 'Сколько стоит каждая функция и где не работает кэш.'
        }
        actions={
          <SegmentedControl
            label="Период"
            value={days}
            onChange={(v) => setDays(v as '7' | '30')}
            options={[
              { value: '7', label: '7 дней' },
              { value: '30', label: '30 дней' },
            ]}
          />
        }
      />

      {error && <Alert tone="danger">{error}</Alert>}

      <div className="usage-stats">
        <Stat label="Стоимость" value={total ? usd(total.costUsd) : null} hint={total?.unpricedCalls ? `без голоса OpenAI (${total.unpricedCalls} выз.)` : 'за период'} />
        <Stat label="Вызовы" value={total ? String(total.calls) : null} hint={total?.errors ? `ошибок: ${total.errors}` : 'без ошибок'} />
        <Stat
          label="Токены"
          value={total ? tokens(promptTokens(total) + total.outputTokens) : null}
          hint={total ? `${tokens(promptTokens(total))} вход · ${tokens(total.outputTokens)} выход` : ' '}
        />
        <Stat label="Из кэша" value={total ? percent(total.cacheShare) : null} hint="доля входа, прочитанная из кэша" />
      </div>

      {shown && (
        <div className="usage-days" role="img" aria-label="Стоимость по дням">
          {shown.daily.map((d) => (
            <div key={d.date} className="usage-day" title={`${new Date(d.date).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}: ${usd(d.costUsd)}, ${d.calls} выз.`}>
              <span className="usage-day-bar" style={{ height: `${dayMax > 0 ? Math.max(d.calls ? 4 : 0, (d.costUsd / dayMax) * 100) : 0}%` }} />
              <span className="usage-day-label ds-num">{d.date.slice(8)}</span>
            </div>
          ))}
        </div>
      )}

      <Card
        title="На что уходит"
        actions={
          <div className="usage-controls">
            <SegmentedControl
              label="Группировка"
              value={groupBy}
              onChange={(v) => setGroupBy(v as AiUsageGroupBy)}
              options={[
                { value: 'feature', label: 'Функции' },
                { value: 'model', label: 'Модели' },
              ]}
            />
            <SegmentedControl
              label="Сортировка"
              value={sort}
              onChange={(v) => setSort(v as SortKey)}
              options={[
                { value: 'cost', label: '$' },
                { value: 'calls', label: 'Вызовы' },
                { value: 'tokens', label: 'Токены' },
                { value: 'perCall', label: 'За вызов' },
              ]}
            />
          </div>
        }
      >
        {!shown && !error && <Skeleton height={120} />}
        {shown && rows.length === 0 && <EmptyState title="За период вызовов не было" />}
        {rows.length > 0 && (
          <ul className="usage-list">
            {rows.map((r) => (
              <UsageRow key={r.key} row={r} groupBy={groupBy} sort={sort} max={max} />
            ))}
          </ul>
        )}
        {rows.some((r) => r.unpricedCalls > 0) && (
          <p className="ds-field-hint usage-note">«Без оценки» — модели OpenAI (расшифровка и живой голос): их цены в таблице нет.</p>
        )}
      </Card>

      {shown && shown.idle.length > 0 && (
        <Card title="Не использовались 30 дней" subtitle="Кандидаты на отключение">
          <ul className="usage-idle">
            {shown.idle.map((f) => (
              <li key={f.key}>
                <span>{label('feature', f.key)}</span>
                <span className="ds-field-hint">{daysAgo(f.lastCallAt)}</span>
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
      <AiUsagePage />
    </Protected>
  );
}
