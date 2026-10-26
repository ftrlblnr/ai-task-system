'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Maximize2, Plus, Sparkles, X } from 'lucide-react';
import type { AgentPageContext } from '@ai-task-system/shared-types';
import { useAuth } from '@/lib/auth-context';
import { AgentMark, Alert, IconButton } from '@/components/ui';
import { useAssistantSession } from '@/components/assistant/use-assistant-session';
import { MessageList } from '@/components/assistant/message-list';
import { Composer } from '@/components/assistant/composer';
import { sectionLabel } from '@/components/sidebar';
import { useAgentPanel, type PageContext } from './agent-context';

// Панель агента справа (редизайн web W2, docs/WEB_REDESIGN.md §4.2) —
// повседневный разговор с ассистентом рядом с любой страницей. Тот же код,
// что у /assistant (components/assistant/*), разговор — последний по
// времени, как в Mini App; «развернуть» открывает его на /assistant.
// Всё, что меняет данные, агент делает только через карточки с
// подтверждением — панель сама ничего не пишет.

// Страницы, где панели нет: вход/регистрация и сам полноэкранный режим.
const NO_PANEL_ROUTES = ['/assistant', '/login', '/register', '/reset-password', '/connect'];

// Подсказки над полем по контексту (макет). «…» на конце — подставить в
// поле и дописать, иначе — отправить сразу.
const CHIPS: Record<AgentPageContext['kind'], string[]> = {
  dashboard: ['/день', '/к-встрече', '/просрочки', '/итоги-недели'],
  task: ['Напомнить исполнителю', 'Почему просрочено?', 'Перенести на четверг'],
  mail: ['Подготовь ответ', 'Короче', 'Официальнее', 'Поручить …'],
  event: ['Подготовь меня к встрече', 'Кто участвует?', 'Перенести на завтра'],
  meeting: ['Какие решения приняли?', 'Поставь задачи по встрече', 'Что поручено мне?'],
  list: ['Что важно сегодня?', 'Что просрочено?', 'Итоги недели'],
};

const KIND_LABELS: Record<AgentPageContext['kind'], string> = {
  dashboard: 'Пульт',
  task: 'Задача',
  mail: 'Письмо',
  event: 'Событие',
  meeting: 'Встреча',
  list: 'Раздел',
};

function contextLabel(ctx: PageContext): string {
  if (ctx.kind === 'dashboard') return 'Пульт';
  return ctx.label ? `${KIND_LABELS[ctx.kind]}: ${ctx.label}` : KIND_LABELS[ctx.kind];
}

// Без контекста от страницы — сам раздел, по первому сегменту пути.
function routeContext(pathname: string): PageContext | null {
  const route = '/' + (pathname.split('/')[1] ?? '');
  if (route === '/') return { kind: 'dashboard' };
  const label = sectionLabel(route);
  return label ? { kind: 'list', route, label } : null;
}

function toPayload(ctx: PageContext | null): AgentPageContext | undefined {
  if (!ctx) return undefined;
  const { kind, id, route, filter } = ctx;
  return { kind, id, route, filter };
}

export function AgentPanel() {
  const { user } = useAuth();
  const { open } = useAgentPanel();
  const pathname = usePathname();
  // Однажды открытая панель остаётся смонтированной — закрытие не обрывает
  // ответ и не теряет переписку.
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) setMounted(true);

  const hiddenHere = NO_PANEL_ROUTES.some((r) => pathname === r || pathname.startsWith(r + '/'));
  if (!user || !mounted || hiddenHere) return null;
  return <AgentPanelBody visible={open} />;
}

function AgentPanelBody({ visible }: { visible: boolean }) {
  const { setOpen, pageContext, focusRequest, pendingAsk, clearAsk } = useAgentPanel();
  const pathname = usePathname();
  const session = useAssistantSession();
  const { convs, conversationId, stream } = session;
  const [initError, setInitError] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const context = pageContext ?? routeContext(pathname);
  const chips = context ? CHIPS[context.kind] : CHIPS.list;

  // Последний разговор или новый, если их ещё нет.
  useEffect(() => {
    void convs.load().then(async (list) => {
      if (!list) return setInitError(true);
      if (list[0]) {
        session.setConversationId(list[0].id);
        stream.loadMessages(list[0].id);
      } else if (!(await session.createConversation())) {
        setInitError(true);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // «Открыть и в поле» (кнопки, Ctrl K) — когда панель видна и разговор готов.
  useEffect(() => {
    if (visible && conversationId && focusRequest > 0) textareaRef.current?.focus();
  }, [visible, conversationId, focusRequest, textareaRef]);

  // Вопрос со страницы (ask) — как только история разговора загружена (иначе
  // её загрузка затрёт вопрос в ленте) и агент свободен.
  const historyLoaded = stream.messages !== null;
  useEffect(() => {
    if (!pendingAsk || !conversationId || !historyLoaded || stream.sending) return;
    clearAsk();
    session.send(toPayload(pendingAsk.context ?? context), pendingAsk.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingAsk, conversationId, historyLoaded, stream.sending]);

  function pickChip(chip: string) {
    if (chip.endsWith('…')) {
      session.setText(chip.slice(0, -1).trimEnd() + ' ');
      textareaRef.current?.focus();
      return;
    }
    session.send(toPayload(context), chip);
  }

  const showChips = !stream.sending && !session.text.trim() && session.voice.phase === 'idle' && !session.live.active;

  return (
    <aside className="agent-panel" hidden={!visible} aria-label="Агент">
      <header className="agent-panel-head">
        <span className="agent-panel-title">
          <AgentMark size={18} state={stream.sending ? 'thinking' : 'idle'} />
          Агент
        </span>
        <span className="ds-spacer" />
        <IconButton icon={Plus} label="Новый разговор" size="sm" disabled={stream.sending} onClick={() => void session.createConversation()} />
        {conversationId && (
          <Link href={`/assistant?c=${conversationId}`} className="ds-iconbtn ds-iconbtn-sm" title="Развернуть" aria-label="Развернуть">
            <Maximize2 size={16} strokeWidth={1.9} />
          </Link>
        )}
        <IconButton icon={X} label="Закрыть панель" size="sm" onClick={() => setOpen(false)} />
      </header>

      {context && (
        <div className="agent-panel-context" title="Агент видит, что открыто на экране">
          <span className="section-kicker">Контекст</span>
          <span className="agent-panel-context-value">{contextLabel(context)}</span>
        </div>
      )}

      {initError && <Alert tone="danger">Не удалось открыть разговор</Alert>}

      <MessageList
        conversationId={conversationId}
        messages={stream.messages}
        loadError={stream.loadError}
        freshMessageIds={stream.freshMessageIds}
        failedSend={stream.failedSend}
        onRetry={stream.retry}
        voiceUndos={session.voice.undos}
        onVoiceUndo={(entry) => void session.voice.undo(entry)}
        onSkillRated={(messageId, run) => stream.setMessages((prev) => prev?.map((x) => (x.id === messageId ? { ...x, skillRun: run } : x)) ?? prev)}
        onSuggestion={session.setText}
        voicePending={session.voice.phase === 'processing' ? session.voice.liveTranscript : null}
        emptyState={
          <p className="agent-panel-empty">
            <Sparkles size={16} strokeWidth={1.9} />
            Спросите о том, что открыто на экране, или поручите задачу.
          </p>
        }
      />

      <div className="agent-panel-foot">
        {showChips && (
          <div className="pill-chips">
            {chips.map((chip) => (
              <button key={chip} type="button" className="pill-chip" disabled={!conversationId} onClick={() => pickChip(chip)}>
                {chip}
              </button>
            ))}
          </div>
        )}
        <Composer
          text={session.text}
          onTextChange={session.setText}
          textareaRef={textareaRef}
          hasConversation={!!conversationId}
          sending={stream.sending}
          onSend={() => session.send(toPayload(context))}
          onStop={stream.stop}
          attachments={session.attachments}
          voice={session.voice}
          live={session.live}
          skillOptions={session.skillOptions}
        />
      </div>
    </aside>
  );
}

// Кнопка «Агент» в шапке страницы — открывает панель; когда панель уже
// открыта (или это /assistant), не показывается.
export function AgentButton() {
  const { open, openAndFocus } = useAgentPanel();
  const pathname = usePathname();
  if (open || NO_PANEL_ROUTES.some((r) => pathname === r || pathname.startsWith(r + '/'))) return null;
  return (
    <button type="button" className="ds-btn ds-btn-secondary agent-open-btn" onClick={openAndFocus}>
      <Sparkles size={16} strokeWidth={1.9} />
      Агент
    </button>
  );
}
