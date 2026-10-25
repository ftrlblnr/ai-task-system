'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Check, Copy, Lightbulb, RefreshCw, RotateCcw, ShoppingBasket, X } from 'lucide-react';
import type { RecommendationArea, RecommendationResult, RecommendationsOverview, RecommendationView } from '@ai-task-system/shared-types';
import { MANAGER_ROLES, RECOMMENDATION_AREA_LABELS, RECOMMENDATION_EFFORT_LABELS } from '@ai-task-system/shared-types';
import { api, ApiError } from '@/lib/api';
import { Protected } from '@/components/protected';
import { Alert, Badge, Button, EmptyState, IconButton, PageHeader, Skeleton, cx } from '@/components/ui';

// «Рекомендации» (ARMS, фаза 5): по пятницам ассистент разбирает неделю и
// предлагает улучшения. Слева — области ARMS, справа — карточки; выбранные
// складываются в корзину и применяются одной кнопкой.

type AreaFilter = RecommendationArea | 'ALL';

const AREAS = Object.keys(RECOMMENDATION_AREA_LABELS) as RecommendationArea[];
const PRIORITY_LABELS: Record<number, string> = { 1: 'Высокий', 2: 'Средний', 3: 'Низкий' };

function errorText(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

function tokens(value: number): string {
  return value < 1000 ? String(value) : `${Math.round(value / 1000)} тыс.`;
}

function when(iso: string): string {
  return new Date(iso).toLocaleString('ru-RU', { timeZone: 'Asia/Almaty', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function resultHref(r: RecommendationResult): string {
  if (r.kind === 'routine') return '/routines';
  if (r.kind === 'memory') return '/memory';
  if (r.kind === 'task') return `/tasks/${r.id}`;
  return `/skills/${r.id}`;
}

function devTaskMarkdown(r: RecommendationView): string {
  return [`## ${r.title}`, `**Зачем:** ${r.benefit}`, `**Что сделать:** ${r.plan}`, r.devTask ?? ''].filter(Boolean).join('\n\n').trim();
}

function RecoCard({ reco, busy, onStatus }: { reco: RecommendationView; busy: boolean; onStatus: (status: 'NEW' | 'IN_CART' | 'DISMISSED') => void }) {
  const [copied, setCopied] = useState(false);
  const inCart = reco.status === 'IN_CART';
  const open = reco.status === 'NEW' || inCart;

  async function copy() {
    await navigator.clipboard.writeText(devTaskMarkdown(reco));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <article className={cx('skill-card', 'reco-card', `is-${reco.area.toLowerCase()}`, inCart && 'is-in-cart', !open && 'is-archived')}>
      <div className="skill-card-head">
        <span className="reco-area">{RECOMMENDATION_AREA_LABELS[reco.area]}</span>
        {reco.status === 'APPLIED' && <Badge tone="ok">Применено</Badge>}
        {reco.status === 'DISMISSED' && <Badge tone="neutral">Отклонено</Badge>}
      </div>
      <h3 className="skill-card-title">{reco.title}</h3>
      <dl className="reco-facts">
        <dt>Польза</dt>
        <dd>{reco.benefit}</dd>
        <dt>Что сделаю</dt>
        <dd>{reco.plan}</dd>
      </dl>
      <p className="ds-field-hint ds-num">
        {RECOMMENDATION_EFFORT_LABELS[reco.effort]} · приоритет {PRIORITY_LABELS[reco.priority]?.toLowerCase() ?? reco.priority}
        {reco.tokenSaving ? ` · экономия ≈${tokens(reco.tokenSaving)} ток./нед.` : ''}
      </p>
      {reco.error && <Alert tone="danger">{reco.error}</Alert>}
      {reco.result && (
        <Link href={resultHref(reco.result)} className="skill-card-result">
          {reco.result.label} →
        </Link>
      )}
      {reco.status !== 'APPLIED' && (
        <div className="skill-card-foot">
          {open ? (
            <Button size="sm" variant="secondary" icon={inCart ? Check : ShoppingBasket} aria-pressed={inCart} disabled={busy} onClick={() => onStatus(inCart ? 'NEW' : 'IN_CART')}>
              {inCart ? 'В корзине' : 'В корзину'}
            </Button>
          ) : (
            <Button size="sm" variant="ghost" icon={RotateCcw} disabled={busy} onClick={() => onStatus('NEW')}>
              Вернуть
            </Button>
          )}
          <span className="ds-spacer" />
          {reco.action === 'DEV_TASK' && <IconButton icon={Copy} label={copied ? 'Скопировано' : 'Скопировать постановку'} size="sm" onClick={() => void copy()} />}
          {open && <IconButton icon={X} label="Отклонить" size="sm" disabled={busy} onClick={() => onStatus('DISMISSED')} />}
        </div>
      )}
    </article>
  );
}

function RecommendationsPage() {
  const [data, setData] = useState<RecommendationsOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [area, setArea] = useState<AreaFilter>('ALL');
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(() => {
    api
      .get<RecommendationsOverview>('/recommendations')
      .then((o) => {
        setData(o);
        setError(null);
      })
      .catch((err) => setError(errorText(err, 'Не удалось загрузить рекомендации')));
  }, []);

  useEffect(load, [load]);

  // Пока идёт сбор — опрашиваем.
  const generating = data?.batch?.status === 'GENERATING';
  useEffect(() => {
    if (!generating) return;
    timer.current = setTimeout(load, 5000);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [generating, data, load]);

  async function generate() {
    try {
      await api.post('/recommendations/generate', {});
      load();
    } catch (err) {
      setError(errorText(err, 'Не удалось запустить сбор'));
    }
  }

  function replace(updated: RecommendationView[]) {
    setData((d) => (d ? { ...d, items: d.items.map((r) => updated.find((u) => u.id === r.id) ?? r) } : d));
  }

  async function setStatus(id: string, status: 'NEW' | 'IN_CART' | 'DISMISSED') {
    setBusy(true);
    try {
      replace([await api.patch<RecommendationView>(`/recommendations/${id}`, { status })]);
    } catch (err) {
      setError(errorText(err, 'Не удалось сохранить'));
    } finally {
      setBusy(false);
    }
  }

  const items = data?.items ?? [];
  const cart = items.filter((r) => r.status === 'IN_CART');

  async function applyCart() {
    setBusy(true);
    setError(null);
    try {
      const out = await api.post<RecommendationView[]>('/recommendations/apply', { ids: cart.map((r) => r.id) });
      replace(out);
      const failed = out.filter((r) => r.status !== 'APPLIED').length;
      if (failed) setError(`Не удалось применить: ${failed}. Причина — на карточке.`);
    } catch (err) {
      setError(errorText(err, 'Не удалось применить'));
    } finally {
      setBusy(false);
    }
  }

  const open = items.filter((r) => r.status === 'NEW' || r.status === 'IN_CART');
  const done = items.filter((r) => r.status === 'APPLIED' || r.status === 'DISMISSED');
  const inArea = (r: RecommendationView) => area === 'ALL' || r.area === area;
  const shown = open.filter(inArea);
  const shownDone = done.filter(inArea);
  const count = (a: AreaFilter) => open.filter((r) => a === 'ALL' || r.area === a).length;
  const batch = data?.batch;

  return (
    <div className="skills-page reco-page">
      <PageHeader
        title="Рекомендации"
        description="По пятницам в 09:00 ассистент разбирает неделю и предлагает, что улучшить. Применяется только выбранное вами."
        actions={
          <Button variant="secondary" icon={RefreshCw} loading={generating} disabled={generating || !data} onClick={() => void generate()}>
            {generating ? 'Собираю…' : 'Собрать сейчас'}
          </Button>
        }
      />
      {error && <Alert tone="danger">{error}</Alert>}
      {batch?.status === 'FAILED' && <Alert tone="warn">Последний сбор не удался — попробуйте ещё раз.</Alert>}
      {!data && !error && <Skeleton height={200} />}
      {data && (
        <div className="reco-layout">
          <nav className="reco-areas" aria-label="Области">
            {(['ALL', ...AREAS] as AreaFilter[]).map((a) => (
              <button key={a} type="button" className={cx('reco-area-btn', a !== 'ALL' && `is-${a.toLowerCase()}`)} aria-pressed={area === a} onClick={() => setArea(a)}>
                <span>{a === 'ALL' ? 'Все' : RECOMMENDATION_AREA_LABELS[a]}</span>
                <span className="ds-num">{count(a) || ''}</span>
              </button>
            ))}
          </nav>
          <div className="reco-main">
            {batch?.finishedAt && batch.status === 'DONE' && <p className="ds-field-hint">Собрано {when(batch.finishedAt)}</p>}
            {shown.length === 0 && (
              <EmptyState
                icon={Lightbulb}
                title={open.length === 0 ? 'Новых рекомендаций нет' : 'В этой области пусто'}
                description={open.length === 0 ? 'Следующие — в пятницу утром. Или нажмите «Собрать сейчас».' : undefined}
              />
            )}
            <div className="skill-deck">
              {shown.map((r) => (
                <RecoCard key={r.id} reco={r} busy={busy} onStatus={(s) => void setStatus(r.id, s)} />
              ))}
            </div>
            {shownDone.length > 0 && (
              <Button variant="ghost" size="sm" className="reco-history-toggle" onClick={() => setHistory((h) => !h)}>
                {history ? 'Скрыть историю' : `Применённые и отклонённые за 30 дней (${shownDone.length})`}
              </Button>
            )}
            {history && (
              <div className="skill-deck">
                {shownDone.map((r) => (
                  <RecoCard key={r.id} reco={r} busy={busy} onStatus={(s) => void setStatus(r.id, s)} />
                ))}
              </div>
            )}
          </div>
        </div>
      )}
      {cart.length > 0 && (
        <div className="reco-cart" role="region" aria-label="Корзина">
          <span>
            В корзине <strong className="ds-num">{cart.length}</strong>
          </span>
          <Button variant="primary" loading={busy} disabled={busy} onClick={() => void applyCart()}>
            Применить выбранное
          </Button>
        </div>
      )}
    </div>
  );
}

export default function Page() {
  return (
    <Protected requireRole={MANAGER_ROLES}>
      <RecommendationsPage />
    </Protected>
  );
}
