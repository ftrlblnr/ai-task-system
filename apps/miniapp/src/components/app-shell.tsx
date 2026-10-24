'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { haptic, loadPref, savePref } from '@/lib/telegram';
import { BottomNav } from './bottom-nav';

// Оболочка Mini App (редизайн M1, владелец 23.10.2026, задание MINIAPP_REDESIGN.md
// §4.1) — заменила SwipeShell: разделы переключаются нижней панелью, свайпа
// между разделами больше нет (конфликтовал со стопкой карточек и чипами).
// Раздел монтируется при первом открытии и дальше остаётся в DOM скрытым —
// ассистент не теряет ленту и стрим, списки — прокрутку. active, как и
// раньше, говорит экрану перезагрузить данные при возврате на него.

export type SectionKey = 'today' | 'tasks' | 'assistant' | 'calendar' | 'reception' | 'trips' | 'mail';

export interface AppSection {
  key: SectionKey;
  label: string;
  icon: LucideIcon;
  render: (active: boolean) => ReactNode;
  // Экран сам раскладывает содержимое на всю высоту (ассистент: лента + поле ввода).
  fill?: boolean;
}

const PREF_KEY = 'miniapp_section';

// Запрос ассистенту из другого раздела («Подготовиться» к встрече, «Ответить»
// на письмо, быстрые вопросы на «Сегодня»): оболочка открывает ассистента, а
// тот отправляет текст, когда догрузит историю. at — чтобы ассистент не
// отправил раньше, чем закончится загрузка, начатая уже после запроса.
export interface AssistantRequest {
  text: string;
  at: number;
}

// Переход в раздел с уточнением («Просрочено» на «Сегодня» → Задачи с этим
// фильтром). Раздел сам забирает значение и сбрасывает его.
export interface SectionIntent {
  key: SectionKey;
  value: string;
}

interface ShellContextValue {
  open: (key: SectionKey, intent?: string) => void;
  intent: SectionIntent | null;
  consumeIntent: () => void;
  askAssistant: (text: string) => void;
  assistantRequest: AssistantRequest | null;
  consumeAssistantRequest: () => void;
}

const ShellContext = createContext<ShellContextValue>({
  open: () => {},
  intent: null,
  consumeIntent: () => {},
  askAssistant: () => {},
  assistantRequest: null,
  consumeAssistantRequest: () => {},
});

// Переход в раздел из глубины экрана («Разделы → Поездки» на «Сегодня» и т.п.).
export function useOpenSection() {
  return useContext(ShellContext).open;
}

export function useSectionIntent(key: SectionKey) {
  const { intent, consumeIntent } = useContext(ShellContext);
  return [intent?.key === key ? intent.value : null, consumeIntent] as const;
}

export function useAskAssistant() {
  return useContext(ShellContext).askAssistant;
}

export function useAssistantRequest() {
  const { assistantRequest, consumeAssistantRequest } = useContext(ShellContext);
  return [assistantRequest, consumeAssistantRequest] as const;
}

export function AppShell({ sections, nav }: { sections: AppSection[]; nav: SectionKey[] }) {
  const [current, setCurrent] = useState<SectionKey>('today');
  const [visited, setVisited] = useState<ReadonlySet<SectionKey>>(() => new Set(['today']));
  const [assistantRequest, setAssistantRequest] = useState<AssistantRequest | null>(null);
  const [intent, setIntent] = useState<SectionIntent | null>(null);

  // Последний открытый раздел — между запусками; первый запуск — «Сегодня».
  // Раздел, которого у пользователя нет (сменилась роль), игнорируется.
  useEffect(() => {
    let cancelled = false;
    void loadPref(PREF_KEY).then((saved) => {
      if (cancelled || !saved || !sections.some((s) => s.key === saved)) return;
      const key = saved as SectionKey;
      setCurrent(key);
      setVisited((v) => new Set(v).add(key));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- только при запуске
  }, []);

  function open(key: SectionKey, value?: string) {
    if (!sections.some((s) => s.key === key)) return;
    setIntent(value ? { key, value } : null);
    if (key !== current) haptic('light');
    setCurrent(key);
    setVisited((v) => (v.has(key) ? v : new Set(v).add(key)));
    savePref(PREF_KEY, key);
  }

  function askAssistant(text: string) {
    setAssistantRequest({ text, at: Date.now() });
    open('assistant');
  }

  const context: ShellContextValue = {
    open,
    intent,
    consumeIntent: () => setIntent(null),
    askAssistant,
    assistantRequest,
    consumeAssistantRequest: () => setAssistantRequest(null),
  };

  return (
    <ShellContext.Provider value={context}>
      <div className="app-shell">
        <main className="app-content">
          {sections
            .filter((s) => visited.has(s.key))
            .map((s) => (
              <section key={s.key} className={s.fill ? 'app-screen is-fill' : 'app-screen'} hidden={s.key !== current} aria-label={s.label}>
                {s.render(s.key === current)}
              </section>
            ))}
        </main>
        <BottomNav items={nav.map((key) => sections.find((s) => s.key === key)!).filter(Boolean)} current={current} onOpen={(key) => open(key)} />
      </div>
    </ShellContext.Provider>
  );
}
