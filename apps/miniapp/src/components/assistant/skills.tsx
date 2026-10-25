'use client';

import { useEffect, useState } from 'react';
import { ThumbsDown, ThumbsUp } from 'lucide-react';
import type { SkillFeedbackValue, SkillListItem, SkillRunRef } from '@ai-task-system/shared-types';
import { api } from '@/lib/api';
import { haptic } from '@/lib/telegram';
import { IconButton, Input, cx } from '@/components/ui';

// Навыки в чате мини-аппа (ARMS, фаза 3): «/» в начале сообщения — список
// команд над полем ввода; под ответом навыка — 👍/👎. Колода и правка
// навыков — только в веб-версии.

export type SkillOption = Pick<SkillListItem, 'id' | 'slug' | 'title' | 'description'>;

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

export function matchSkills(text: string, skills: SkillOption[]): SkillOption[] {
  const m = /^\/(\S*)$/.exec(text);
  if (!m) return [];
  const q = m[1].toLowerCase();
  return skills.filter((s) => s.slug.startsWith(q) || (q.length > 1 && s.title.toLowerCase().includes(q)));
}

export function SkillSuggest({ options, onPick }: { options: SkillOption[]; onPick: (s: SkillOption) => void }) {
  if (options.length === 0) return null;
  return (
    <div className="list-card skill-suggest" role="listbox" aria-label="Навыки">
      {options.map((s) => (
        <button
          key={s.id}
          type="button"
          role="option"
          aria-selected={false}
          className="skill-suggest-row"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            haptic('light');
            onPick(s);
          }}
        >
          <span className="skill-suggest-slug">/{s.slug}</span>
          <span className="skill-suggest-desc">{s.description}</span>
        </button>
      ))}
    </div>
  );
}

export function SkillRating({ run }: { run: SkillRunRef }) {
  const [feedback, setFeedback] = useState<SkillFeedbackValue | null>(run.feedback);
  const [asking, setAsking] = useState(false);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);

  async function rate(value: SkillFeedbackValue, text?: string) {
    setBusy(true);
    try {
      const updated = await api.post<SkillRunRef>(`/skills/runs/${run.id}/feedback`, { value, text });
      setFeedback(updated.feedback);
      setAsking(false);
      haptic('light');
    } catch {
      // Не критично: можно нажать ещё раз.
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="skill-rate">
      <span className="skill-rate-label">/{run.slug}</span>
      <IconButton icon={ThumbsUp} label="Хороший ответ" size="sm" className={cx(feedback === 'UP' && 'is-chosen')} disabled={busy} onClick={() => void rate('UP')} />
      <IconButton icon={ThumbsDown} label="Что-то не так" size="sm" className={cx(feedback === 'DOWN' && 'is-chosen')} disabled={busy} onClick={() => setAsking((v) => !v)} />
      {asking && (
        <form
          className="skill-rate-form"
          onSubmit={(e) => {
            e.preventDefault();
            void rate('DOWN', comment);
          }}
        >
          <Input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Что не так?" maxLength={1000} autoFocus aria-label="Что не так" enterKeyHint="send" />
        </form>
      )}
    </div>
  );
}
