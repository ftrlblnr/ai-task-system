'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, Check, Mail, Play, Sparkles, ThumbsDown, ThumbsUp, Trash2 } from 'lucide-react';
import type { SkillDetail, SkillEffort, SkillKind, SkillModel, SkillOutput, SkillRevisionView, SkillToolOption, SkillView, UpdateSkillInput } from '@ai-task-system/shared-types';
import { MANAGER_ROLES, SKILL_EFFORT_LABELS, SKILL_KIND_LABELS, SKILL_MODEL_LABELS, SKILL_OUTPUT_LABELS } from '@ai-task-system/shared-types';
import { api } from '@/lib/api';
import { Protected } from '@/components/protected';
import { Alert, Badge, Button, Card, Checkbox, Field, IconButton, Input, PageHeader, Select, Skeleton, Textarea } from '@/components/ui';
import { errorText, lineDiff, useSkillRun } from '../skill-ui';

// Страница навыка (ARMS, фаза 3): инструкция, модель, инструменты, правки
// от ИИ (применяет только человек), отзывы, история версий, расход.

const KINDS = Object.keys(SKILL_KIND_LABELS) as SkillKind[];
const MODELS = Object.keys(SKILL_MODEL_LABELS) as SkillModel[];
const EFFORTS = Object.keys(SKILL_EFFORT_LABELS) as SkillEffort[];
const OUTPUTS = Object.keys(SKILL_OUTPUT_LABELS) as SkillOutput[];
const TONE_SLUG = 'тон';

const SOURCE_LABELS: Record<SkillRevisionView['source'], string> = { MANUAL: 'Вручную', FEEDBACK: 'По отзывам', SENT_MAIL: 'Из отправленных писем' };
const STATUS_LABELS: Record<SkillRevisionView['status'], string> = {
  GENERATING: 'готовится',
  PROPOSED: 'ждёт решения',
  APPLIED: 'применена',
  REJECTED: 'отклонена',
  FAILED: 'не удалось',
};

type Draft = Pick<SkillView, 'title' | 'description' | 'kind' | 'instructions' | 'model' | 'effort' | 'output' | 'allowedTools'>;

function draftOf(s: SkillView): Draft {
  return { title: s.title, description: s.description, kind: s.kind, instructions: s.instructions, model: s.model, effort: s.effort, output: s.output, allowedTools: s.allowedTools };
}

function Diff({ before, after }: { before: string; after: string }) {
  return (
    <pre className="skill-diff">
      {lineDiff(before, after).map((l, i) => (
        <span key={i} className={`skill-diff-${l.kind}`}>
          {l.kind === 'add' ? '+ ' : l.kind === 'del' ? '− ' : '  '}
          {l.text}
          {'\n'}
        </span>
      ))}
    </pre>
  );
}

function SkillPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [tools, setTools] = useState<SkillToolOption[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const run = useSkillRun(id);

  const load = useCallback(() => {
    api
      .get<SkillDetail>(`/skills/${id}`)
      .then((d) => {
        setDetail(d);
        setDraft((prev) => prev ?? draftOf(d.skill));
        setError(null);
      })
      .catch((err) => setError(errorText(err, 'Не удалось загрузить навык')));
  }, [id]);

  useEffect(load, [load]);
  useEffect(() => {
    api.get<SkillToolOption[]>('/skills/tools').then(setTools).catch(() => undefined);
  }, []);

  // Предложение готовится в фоне — опрашиваем, пока не появится.
  const generating = detail?.revisions.some((r) => r.status === 'GENERATING') ?? false;
  useEffect(() => {
    if (!generating) return;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [generating, load]);

  if (!detail || !draft) {
    return error ? <Alert tone="danger">{error}</Alert> : <Skeleton height={320} />;
  }
  const skill = detail.skill;
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftOf(skill));
  const proposed = detail.revisions.find((r) => r.status === 'PROPOSED');
  const set = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const hasFeedback = detail.feedback.length > 0;

  async function save(body: UpdateSkillInput) {
    setSaving(true);
    try {
      const updated = await api.patch<SkillView>(`/skills/${id}`, body);
      setDraft(draftOf(updated));
      setDetail((d) => (d ? { ...d, skill: updated } : d));
      load();
    } catch (err) {
      setError(errorText(err, 'Не удалось сохранить'));
    } finally {
      setSaving(false);
    }
  }

  async function requestRevision(source: 'FEEDBACK' | 'SENT_MAIL') {
    setRequesting(true);
    try {
      await api.post(`/skills/${id}/revisions`, { source });
      load();
    } catch (err) {
      setError(errorText(err, 'Не удалось запросить предложение'));
    } finally {
      setRequesting(false);
    }
  }

  async function decide(revisionId: string, apply: boolean) {
    try {
      if (apply) {
        const updated = await api.post<SkillView>(`/skills/revisions/${revisionId}/apply`);
        setDraft(draftOf(updated));
      } else {
        await api.post(`/skills/revisions/${revisionId}/reject`);
      }
      load();
    } catch (err) {
      setError(errorText(err, 'Не удалось сохранить решение'));
    }
  }

  async function remove() {
    if (!window.confirm(`Удалить навык /${skill.slug}?`)) return;
    try {
      await api.delete(`/skills/${id}`);
      router.push('/skills');
    } catch (err) {
      setError(errorText(err, 'Не удалось удалить'));
    }
  }

  return (
    <div className="skills-page">
      <Link href="/skills" className="skill-back">
        <ArrowLeft size={16} strokeWidth={1.8} /> Навыки
      </Link>
      <PageHeader
        title={
          <>
            <span className="mono skill-title-slug">/{skill.slug}</span> {skill.title}
          </>
        }
        description={`${skill.description} · версия ${skill.version}${skill.shared ? ' · общий' : ''}`}
        actions={
          skill.enabled && (
            <Button variant="primary" icon={Play} disabled={run.busy} onClick={() => void run.start()}>
              Запустить
            </Button>
          )
        }
      />
      {run.label && (
        <p className="ds-field-hint">
          {run.label}
          {run.conversationId && (
            <>
              {' · '}
              <Link href={`/assistant?c=${run.conversationId}`}>открыть ответ</Link>
            </>
          )}
        </p>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
      {!skill.enabled && <Alert tone="warn">Навык в архиве: не вызывается и не подсказывается в чате.</Alert>}

      {proposed && proposed.instructions && (
        <Card tone="agent" title="Предложенная правка" subtitle={`${SOURCE_LABELS[proposed.source]}${proposed.reason ? ` — ${proposed.reason}` : ''}`}>
          {proposed.baseVersion !== skill.version && <Alert tone="warn">Навык изменили после предложения — применить не получится, запросите новое.</Alert>}
          <Diff before={skill.instructions} after={proposed.instructions} />
          <div className="skill-form-actions">
            <Button variant="primary" icon={Check} disabled={proposed.baseVersion !== skill.version} onClick={() => void decide(proposed.id, true)}>
              Применить
            </Button>
            <Button variant="ghost" onClick={() => void decide(proposed.id, false)}>
              Отклонить
            </Button>
          </div>
        </Card>
      )}

      <Card title="Инструкция">
        <form
          className="skill-form"
          onSubmit={(e) => {
            e.preventDefault();
            void save(draft);
          }}
        >
          <div className="skill-form-row">
            <Field label="Название">
              <Input value={draft.title} onChange={(e) => set({ title: e.target.value })} maxLength={80} />
            </Field>
            <Field label="Когда вызывать">
              <Input value={draft.description} onChange={(e) => set({ description: e.target.value })} maxLength={200} />
            </Field>
          </div>
          <Textarea className="skill-instructions" value={draft.instructions} onChange={(e) => set({ instructions: e.target.value })} rows={14} aria-label="Инструкция" />
          <div className="skill-form-row">
            <Field label="Вид">
              <Select value={draft.kind} onChange={(e) => set({ kind: e.target.value as SkillKind })} options={KINDS.map((k) => ({ value: k, label: SKILL_KIND_LABELS[k] }))} />
            </Field>
            <Field label="Модель">
              <Select value={draft.model} onChange={(e) => set({ model: e.target.value as SkillModel })} options={MODELS.map((m) => ({ value: m, label: SKILL_MODEL_LABELS[m] }))} />
            </Field>
            <Field label="Усилие">
              <Select value={draft.effort} onChange={(e) => set({ effort: e.target.value as SkillEffort })} options={EFFORTS.map((m) => ({ value: m, label: SKILL_EFFORT_LABELS[m] }))} />
            </Field>
            <Field label="Результат">
              <Select value={draft.output} onChange={(e) => set({ output: e.target.value as SkillOutput })} options={OUTPUTS.map((m) => ({ value: m, label: SKILL_OUTPUT_LABELS[m] }))} />
            </Field>
          </div>
          <Field label="Инструменты" hint="Навык видит только отмеченные — и только те, что доступны вашей роли.">
            <div className="skill-tools">
              {tools.map((t) => (
                <Checkbox
                  key={t.name}
                  label={t.label}
                  checked={draft.allowedTools.includes(t.name)}
                  onChange={(e) => set({ allowedTools: e.target.checked ? [...draft.allowedTools, t.name] : draft.allowedTools.filter((n) => n !== t.name) })}
                />
              ))}
            </div>
          </Field>
          <div className="skill-form-actions">
            <Button type="submit" variant="primary" disabled={!dirty || saving || draft.instructions.trim().length < 10} loading={saving}>
              Сохранить
            </Button>
            {dirty && (
              <Button type="button" variant="ghost" onClick={() => setDraft(draftOf(skill))}>
                Отменить правки
              </Button>
            )}
            <span className="ds-spacer" />
            <Button type="button" variant="ghost" onClick={() => void save({ enabled: !skill.enabled })}>
              {skill.enabled ? 'В архив' : 'Вернуть из архива'}
            </Button>
            {skill.own && <IconButton icon={Trash2} label="Удалить навык" onClick={() => void remove()} />}
          </div>
        </form>
      </Card>

      <Card
        title="Отзывы"
        subtitle="👍/👎 под ответами навыка в чате. По ним ИИ предложит правку инструкции — применяете вы."
        actions={
          <div className="skill-form-actions">
            {skill.slug === TONE_SLUG && (
              <Button size="sm" variant="secondary" icon={Mail} disabled={generating || requesting} onClick={() => void requestRevision('SENT_MAIL')}>
                Собрать из писем
              </Button>
            )}
            <span title={hasFeedback ? undefined : 'Сначала оцените ответы навыка'}>
              <Button size="sm" variant="agent" icon={Sparkles} disabled={!hasFeedback || generating || requesting} onClick={() => void requestRevision('FEEDBACK')}>
                Обучить навык
              </Button>
            </span>
          </div>
        }
      >
        {generating && <p className="ds-field-hint">Готовлю предложение — это минута-две…</p>}
        {detail.feedback.length === 0 ? (
          <p className="ds-field-hint">Отзывов пока нет.</p>
        ) : (
          <ul className="skill-feedback">
            {detail.feedback.map((f) => (
              <li key={f.id}>
                {f.feedback === 'UP' ? <ThumbsUp size={15} strokeWidth={1.8} className="is-up" /> : <ThumbsDown size={15} strokeWidth={1.8} className="is-down" />}
                <div>
                  <span>{f.feedbackText || (f.feedback === 'UP' ? 'Хороший ответ' : 'Без комментария')}</span>
                  <span className="ds-field-hint">
                    {f.inputText ? `«${f.inputText}» · ` : ''}
                    {f.feedbackAt ? new Date(f.feedbackAt).toLocaleDateString('ru-RU') : ''}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card tone="sunken" title="История и расход">
        <p className="ds-field-hint">
          За 30 дней: {detail.stats.runs30d} запусков · {detail.stats.calls30d} вызовов модели · ${detail.stats.costUsd30d.toFixed(2)}
        </p>
        <ul className="skill-history">
          {detail.revisions.map((r) => (
            <li key={r.id}>
              <Badge tone={r.status === 'APPLIED' ? 'ok' : r.status === 'PROPOSED' ? 'agent' : r.status === 'FAILED' ? 'danger' : 'neutral'}>{STATUS_LABELS[r.status]}</Badge>
              <span>
                {SOURCE_LABELS[r.source]} · {new Date(r.createdAt).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })}
                {r.reason && r.source !== 'MANUAL' ? ` — ${r.reason}` : ''}
                {r.error ? ` — ${r.error}` : ''}
              </span>
            </li>
          ))}
          {detail.revisions.length === 0 && <li className="ds-field-hint">Версия 1 — исходная.</li>}
        </ul>
      </Card>
    </div>
  );
}

export default function Page() {
  return (
    <Protected requireRole={MANAGER_ROLES}>
      <SkillPage />
    </Protected>
  );
}
