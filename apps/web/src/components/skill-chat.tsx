'use client';

import { useEffect, useState } from 'react';
import { ThumbsDown, ThumbsUp } from 'lucide-react';
import type { SkillFeedbackValue, SkillListItem, SkillRunRef } from '@ai-task-system/shared-types';
import { api } from '@/lib/api';
import { Button, IconButton, Input, cx } from '@/components/ui';

// Навыки в чате (ARMS, фаза 3): подсказки «/команда» над полем ввода и
// 👍/👎 под ответом навыка.

export type SkillOption = Pick<SkillListItem, 'id' | 'slug' | 'title' | 'description'>;

// Список навыков — один раз, только руководству (остальным «/» — просто текст).
export function useSkillOptions(enabled: boolean): SkillOption[] {
  const [skills, setSkills] = useState<SkillOption[]>([]);
  useEffect(() => {
    if (!enabled) return;
    api
      .get<SkillListItem[]>('/skills')
      .then((list) => setSkills(list.filter((s) => s.enabled)))
      .catch(() => setSkills([]));
  }, [enabled]);
  return skills;
}

// Подсказки видны, пока набирается сама команда: «/», «/к-вс».
export function matchSkills(text: string, skills: SkillOption[]): SkillOption[] {
  const m = /^\/(\S*)$/.exec(text);
  if (!m) return [];
  const q = m[1].toLowerCase();
  return skills.filter((s) => s.slug.startsWith(q) || (q.length > 1 && s.title.toLowerCase().includes(q)));
}

export function SkillSuggest({ options, active, onPick }: { options: SkillOption[]; active: number; onPick: (s: SkillOption) => void }) {
  if (options.length === 0) return null;
  return (
    <ul className="skill-suggest" role="listbox" aria-label="Навыки">
      {options.map((s, i) => (
        <li key={s.id} role="option" aria-selected={i === active}>
          <button
            type="button"
            className={cx(i === active && 'is-active')}
            // mousedown, не click: иначе поле ввода теряет фокус раньше выбора.
            onMouseDown={(e) => {
              e.preventDefault();
              onPick(s);
            }}
          >
            <span className="mono">/{s.slug}</span>
            <span className="ds-field-hint">{s.description}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

// 👎 сразу открывает «что не так?» — комментарий нужен для «Обучить навык».
export function SkillRating({ run, onRated }: { run: SkillRunRef; onRated: (run: SkillRunRef) => void }) {
  const [asking, setAsking] = useState(false);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);

  async function rate(value: SkillFeedbackValue, text?: string) {
    setBusy(true);
    try {
      onRated(await api.post<SkillRunRef>(`/skills/runs/${run.id}/feedback`, { value, text }));
      setAsking(false);
    } catch {
      // Отзыв не критичен: кнопки остаются, можно нажать ещё раз.
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="skill-rate">
      <span className="ds-field-hint">Навык /{run.slug}</span>
      <IconButton icon={ThumbsUp} label="Хороший ответ" size="sm" className={cx(run.feedback === 'UP' && 'is-chosen')} disabled={busy} onClick={() => void rate('UP')} />
      <IconButton icon={ThumbsDown} label="Что-то не так" size="sm" className={cx(run.feedback === 'DOWN' && 'is-chosen')} disabled={busy} onClick={() => setAsking((v) => !v)} />
      {asking && (
        <form
          className="skill-rate-form"
          onSubmit={(e) => {
            e.preventDefault();
            void rate('DOWN', comment);
          }}
        >
          <Input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Что не так? Например: слишком длинно" maxLength={1000} autoFocus aria-label="Что не так" />
          <Button type="submit" size="sm" disabled={busy}>
            Отправить
          </Button>
        </form>
      )}
    </div>
  );
}
