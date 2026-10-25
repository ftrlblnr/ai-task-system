'use client';

import { useEffect, useRef, useState } from 'react';
import { BookOpen, ListChecks, Zap } from 'lucide-react';
import type { SkillRunState, SkillView } from '@ai-task-system/shared-types';
import { SKILL_EFFORT_LABELS, SKILL_MODEL_LABELS, SKILL_OUTPUT_LABELS } from '@ai-task-system/shared-types';
import { api, ApiError } from '@/lib/api';
import { Badge } from '@/components/ui';

// Общее для колоды навыков и страницы навыка (ARMS, фаза 3).

export const KIND_ICON = { ACTION: Zap, PLAYBOOK: ListChecks, KNOWLEDGE: BookOpen } as const;

export function errorText(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

export function SkillChips({ skill }: { skill: Pick<SkillView, 'model' | 'effort' | 'output'> }) {
  return (
    <div className="skill-chips">
      <Badge tone="outline">{SKILL_MODEL_LABELS[skill.model]}</Badge>
      <Badge tone="outline">{SKILL_EFFORT_LABELS[skill.effort]}</Badge>
      {skill.output !== 'CHAT' && <Badge tone="outline">{SKILL_OUTPUT_LABELS[skill.output]}</Badge>}
    </div>
  );
}

const RUN_LABELS: Record<SkillRunState['status'], string> = {
  QUEUED: 'В очереди…',
  RUNNING: 'Выполняется…',
  SUCCEEDED: 'Готово',
  FAILED: 'Не удалось',
};

// ▶ навыка: ставим запуск и опрашиваем его статус, пока не закончится.
export function useSkillRun(skillId: string) {
  const [run, setRun] = useState<SkillRunState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  function poll(id: string) {
    timer.current = setTimeout(() => {
      api
        .get<SkillRunState>(`/skills/runs/${id}`)
        .then((r) => {
          setRun(r);
          if (r.status === 'QUEUED' || r.status === 'RUNNING') poll(id);
        })
        .catch(() => poll(id));
    }, 3000);
  }

  async function start() {
    setError(null);
    try {
      const r = await api.post<SkillRunState>(`/skills/${skillId}/run`, { clientRequestId: crypto.randomUUID() });
      setRun(r);
      poll(r.id);
    } catch (err) {
      setError(errorText(err, 'Не удалось запустить'));
    }
  }

  const busy = run?.status === 'QUEUED' || run?.status === 'RUNNING';
  const label = error ?? (run ? (run.status === 'FAILED' && run.error ? `${RUN_LABELS.FAILED}: ${run.error}` : RUN_LABELS[run.status]) : null);
  return { start, busy, label, conversationId: run?.status === 'SUCCEEDED' ? run.conversationId : null };
}

export type DiffLine = { kind: 'same' | 'add' | 'del'; text: string };

// Построчный дифф (LCS) — инструкции навыка короткие, квадратичная таблица ок.
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) out.push({ kind: 'del', text: a[i++] });
    else out.push({ kind: 'add', text: b[j++] });
  }
  while (i < n) out.push({ kind: 'del', text: a[i++] });
  while (j < m) out.push({ kind: 'add', text: b[j++] });
  return out;
}
