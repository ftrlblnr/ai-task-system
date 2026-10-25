'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Archive, ArchiveRestore, Play, Plus, Settings2 } from 'lucide-react';
import type { CreateSkillInput, SkillEffort, SkillKind, SkillListItem, SkillModel, SkillView } from '@ai-task-system/shared-types';
import { MANAGER_ROLES, SKILL_EFFORT_LABELS, SKILL_KIND_LABELS, SKILL_MODEL_LABELS, SKILL_SLUG_PATTERN } from '@ai-task-system/shared-types';
import { api } from '@/lib/api';
import { Protected } from '@/components/protected';
import { Alert, Badge, Button, Card, EmptyState, Field, IconButton, Input, PageHeader, SegmentedControl, Select, Skeleton, Textarea } from '@/components/ui';
import { errorText, KIND_ICON, SkillChips, useSkillRun } from './skill-ui';

// «Навыки» (ARMS, фаза 3): колода карточек. Навык — инструкция + модель +
// инструменты; вызывается «/команда» в чате или ▶ здесь (результат —
// отдельным разговором ассистента и в Telegram).

function SkillCard({ skill, onToggle }: { skill: SkillListItem; onToggle: () => Promise<void> }) {
  const Icon = KIND_ICON[skill.kind];
  const run = useSkillRun(skill.id);
  const router = useRouter();
  return (
    <article className={skill.enabled ? 'skill-card' : 'skill-card is-archived'}>
      <div className="skill-card-head">
        <span className="skill-card-icon" aria-hidden>
          <Icon size={18} strokeWidth={1.8} />
        </span>
        <span className="skill-slug mono">/{skill.slug}</span>
        {skill.pendingRevisions > 0 && <Badge tone="agent">Есть правка</Badge>}
      </div>
      <Link href={`/skills/${skill.id}`} className="skill-card-title">
        {skill.title}
      </Link>
      <p className="skill-card-desc">{skill.description}</p>
      <SkillChips skill={skill} />
      <div className="skill-card-foot">
        <span className="ds-field-hint">{run.label ?? (skill.runs30d > 0 ? `${skill.runs30d} за 30 дней` : SKILL_KIND_LABELS[skill.kind])}</span>
        <span className="ds-spacer" />
        {skill.enabled && <IconButton icon={Play} label="Запустить" size="sm" disabled={run.busy} onClick={() => void run.start()} />}
        <IconButton icon={Settings2} label="Настроить" size="sm" onClick={() => router.push(`/skills/${skill.id}`)} />
        <IconButton icon={skill.enabled ? Archive : ArchiveRestore} label={skill.enabled ? 'В архив' : 'Вернуть'} size="sm" onClick={() => void onToggle()} />
      </div>
      {run.conversationId && (
        <Link href={`/assistant?c=${run.conversationId}`} className="skill-card-result">
          Открыть ответ →
        </Link>
      )}
    </article>
  );
}

const KINDS = Object.keys(SKILL_KIND_LABELS) as SkillKind[];
const MODELS = Object.keys(SKILL_MODEL_LABELS) as SkillModel[];
const EFFORTS = Object.keys(SKILL_EFFORT_LABELS) as SkillEffort[];
const SLUG_RE = new RegExp(SKILL_SLUG_PATTERN);

function CreateForm({ onCreated, onCancel }: { onCreated: (s: SkillView) => void; onCancel: () => void }) {
  const [form, setForm] = useState<CreateSkillInput>({ slug: '', title: '', description: '', kind: 'PLAYBOOK', instructions: '', model: 'HAIKU', effort: 'LOW' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<CreateSkillInput>) => setForm((f) => ({ ...f, ...patch }));
  const slugOk = SLUG_RE.test(form.slug);
  const valid = slugOk && form.title.trim().length >= 2 && form.description.trim().length >= 2 && form.instructions.trim().length >= 10;

  async function submit() {
    setBusy(true);
    try {
      onCreated(await api.post<SkillView>('/skills', form));
    } catch (err) {
      setError(errorText(err, 'Не удалось создать навык'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Новый навык">
      <form
        className="skill-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="skill-form-row">
          <Field label="Команда" error={form.slug && !slugOk ? 'Строчные буквы и цифры, слова через дефис' : undefined}>
            <Input value={form.slug} onChange={(e) => set({ slug: e.target.value.toLowerCase() })} placeholder="сводка-объекта" maxLength={32} autoFocus />
          </Field>
          <Field label="Название">
            <Input value={form.title} onChange={(e) => set({ title: e.target.value })} placeholder="Сводка по объекту" maxLength={80} />
          </Field>
        </div>
        <Field label="Когда вызывать">
          <Input value={form.description} onChange={(e) => set({ description: e.target.value })} placeholder="Одна строка: что делает навык" maxLength={200} />
        </Field>
        <div className="skill-form-row">
          <Field label="Вид">
            <Select value={form.kind} onChange={(e) => set({ kind: e.target.value as SkillKind })} options={KINDS.map((k) => ({ value: k, label: SKILL_KIND_LABELS[k] }))} />
          </Field>
          <Field label="Модель">
            <Select value={form.model} onChange={(e) => set({ model: e.target.value as SkillModel })} options={MODELS.map((m) => ({ value: m, label: SKILL_MODEL_LABELS[m] }))} />
          </Field>
          <Field label="Усилие">
            <Select value={form.effort} onChange={(e) => set({ effort: e.target.value as SkillEffort })} options={EFFORTS.map((m) => ({ value: m, label: SKILL_EFFORT_LABELS[m] }))} />
          </Field>
        </div>
        <Field label="Инструкция" hint="Шаги и формат ответа. Инструменты выберете на странице навыка.">
          <Textarea value={form.instructions} onChange={(e) => set({ instructions: e.target.value })} rows={6} />
        </Field>
        <div className="skill-form-actions">
          <Button type="submit" variant="primary" disabled={!valid || busy} loading={busy}>
            Создать
          </Button>
          <Button type="button" variant="ghost" onClick={onCancel}>
            Отмена
          </Button>
        </div>
      </form>
    </Card>
  );
}

function SkillsPage() {
  const [skills, setSkills] = useState<SkillListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<'ACTIVE' | 'ARCHIVED'>('ACTIVE');
  const [creating, setCreating] = useState(false);
  const router = useRouter();

  const load = useCallback(() => {
    api
      .get<SkillListItem[]>('/skills')
      .then((list) => {
        setSkills(list);
        setError(null);
      })
      .catch((err) => setError(errorText(err, 'Не удалось загрузить навыки')));
  }, []);

  useEffect(load, [load]);

  async function toggle(skill: SkillListItem) {
    try {
      const updated = await api.patch<SkillView>(`/skills/${skill.id}`, { enabled: !skill.enabled });
      setSkills((prev) => prev?.map((s) => (s.id === skill.id ? { ...s, ...updated } : s)) ?? prev);
    } catch (err) {
      setError(errorText(err, 'Не удалось сохранить'));
    }
  }

  const shown = (skills ?? []).filter((s) => (view === 'ACTIVE' ? s.enabled : !s.enabled));
  const archivedCount = skills?.filter((s) => !s.enabled).length ?? 0;

  return (
    <div className="skills-page">
      <PageHeader
        title="Навыки"
        description="Готовые сценарии ассистента. Вызов — «/команда» в чате или ▶ здесь: ответ придёт в ассистент и в Telegram."
        actions={
          !creating && (
            <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>
              Новый навык
            </Button>
          )
        }
      />
      {error && <Alert tone="danger">{error}</Alert>}
      {creating && (
        <CreateForm
          onCancel={() => setCreating(false)}
          onCreated={(s) => router.push(`/skills/${s.id}`)}
        />
      )}
      {archivedCount > 0 && (
        <SegmentedControl
          label="Показать"
          value={view}
          onChange={(v) => setView(v as 'ACTIVE' | 'ARCHIVED')}
          options={[
            { value: 'ACTIVE', label: 'Активные' },
            { value: 'ARCHIVED', label: `Архив · ${archivedCount}` },
          ]}
        />
      )}
      {!skills && !error && <Skeleton height={200} />}
      {skills && shown.length === 0 && <EmptyState title={view === 'ACTIVE' ? 'Навыков нет' : 'Архив пуст'} />}
      <div className="skill-deck">
        {shown.map((s) => (
          <SkillCard key={s.id} skill={s} onToggle={() => toggle(s)} />
        ))}
      </div>
    </div>
  );
}

export default function Page() {
  return (
    <Protected requireRole={MANAGER_ROLES}>
      <SkillsPage />
    </Protected>
  );
}

