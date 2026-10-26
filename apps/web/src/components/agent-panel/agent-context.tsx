'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import type { AgentPageContext } from '@ai-task-system/shared-types';

// Панель агента (редизайн web W2, docs/WEB_REDESIGN.md §4.2): открыта ли
// она и на что смотрит пользователь. Страница сообщает контекст через
// useAgentContext(...) — задача, письмо, событие, встреча; без него панель
// считает контекстом сам раздел (kind: 'list'). На сервер уходят только
// вид и id — сущность и права проверяет PageContextService.

export type PageContext = AgentPageContext & {
  // Подпись для чипа «Контекст: …» — только для показа, на сервер не уходит.
  label?: string;
};

const OPEN_KEY = 'agentPanel.open';

interface AgentPanelState {
  open: boolean;
  setOpen: (open: boolean) => void;
  // Открыть и поставить курсор в поле ввода (кнопки «Агент», Ctrl K).
  openAndFocus: () => void;
  // Растёт при каждом «открыть и в поле» — панель ставит курсор, когда
  // разговор загружен (до этого поле недоступно).
  focusRequest: number;
  pageContext: PageContext | null;
  setPageContext: (context: PageContext | null) => void;
  // Открыть панель и сразу задать вопрос («Подготовиться» на пульте) —
  // контекст вопроса, если он не тот, что на экране.
  ask: (text: string, context?: PageContext) => void;
  pendingAsk: PendingAsk | null;
  clearAsk: () => void;
}

export interface PendingAsk {
  text: string;
  context?: PageContext;
}

const AgentPanelContext = createContext<AgentPanelState | null>(null);

function readOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) === '1';
  } catch {
    return false;
  }
}

// Поле ввода полноэкранной страницы /assistant.
function focusAssistantPage() {
  document.querySelector<HTMLTextAreaElement>('.assistant-chat-pane textarea')?.focus();
}

function isTypingElsewhere(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.closest('.agent-panel')) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

export function AgentPanelProvider({ children }: { children: ReactNode }) {
  const [open, setOpenState] = useState(readOpen);
  const [pageContext, setPageContext] = useState<PageContext | null>(null);
  const [focusRequest, setFocusRequest] = useState(0);
  const [pendingAsk, setPendingAsk] = useState<PendingAsk | null>(null);
  const pathname = usePathname();

  function setOpen(next: boolean) {
    setOpenState(next);
    try {
      localStorage.setItem(OPEN_KEY, next ? '1' : '0');
    } catch {
      // приватный режим — состояние просто не запомнится
    }
  }

  function openAndFocus() {
    // На /assistant панели нет — там своё поле ввода.
    if (pathname.startsWith('/assistant')) return focusAssistantPage();
    setOpen(true);
    setFocusRequest((n) => n + 1);
  }

  function ask(text: string, context?: PageContext) {
    setPendingAsk({ text, context });
    setOpen(true);
  }

  // Ctrl K / Cmd K: открыть панель и перейти в поле; если курсор уже в
  // панели — закрыть. В чужом поле ввода сочетание не перехватываем.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'k' || e.altKey || e.shiftKey) return;
      if (isTypingElsewhere(e.target)) return;
      e.preventDefault();
      const inPanel = document.activeElement instanceof HTMLElement && document.activeElement.closest('.agent-panel');
      if (open && inPanel) {
        setOpen(false);
        return;
      }
      openAndFocus();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  return (
    <AgentPanelContext.Provider value={{ open, setOpen, openAndFocus, focusRequest, pageContext, setPageContext, ask, pendingAsk, clearAsk: () => setPendingAsk(null) }}>{children}</AgentPanelContext.Provider>
  );
}

export function useAgentPanel(): AgentPanelState {
  const state = useContext(AgentPanelContext);
  if (!state) throw new Error('useAgentPanel: нет AgentPanelProvider выше по дереву');
  return state;
}

// Страница сообщает, на что смотрит пользователь; null — ничего особенного
// (тогда контекст — раздел). Снимается при уходе со страницы.
export function useAgentContext(context: PageContext | null) {
  const { setPageContext } = useAgentPanel();
  const key = context ? JSON.stringify(context) : '';
  useEffect(() => {
    if (!key) return;
    setPageContext(JSON.parse(key) as PageContext);
    return () => setPageContext(null);
  }, [key, setPageContext]);
}
