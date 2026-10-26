'use client';

import { useState } from 'react';
import { isManagerRole, type AgentPageContext } from '@ai-task-system/shared-types';
import { useSkillOptions } from '@/components/skill-chat';
import { useAuth } from '@/lib/auth-context';
import { useAssistantStream } from './use-assistant-stream';
import { useLiveVoice, useVoiceRecorder } from './voice-controls';
import { useAttachments } from './attachments';
import { useConversations } from './conversation-list';

// Всё, что нужно разговору с ассистентом: список разговоров, выбранный
// разговор, переписка, поле ввода, вложения, голос. Общий код страницы
// /assistant и панели агента (редизайн web W2) — у каждой свой экземпляр,
// одновременно они не показываются. Ref поля ввода — у компонента (правило
// react-hooks/refs: объект с ref нельзя читать в рендере).
export function useAssistantSession() {
  const convs = useConversations();
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [text, setText] = useState('');

  const stream = useAssistantStream({ conversationId, onTitlesChanged: convs.refreshTitles });
  const attachments = useAttachments();
  const voice = useVoiceRecorder({
    conversationId,
    onMessages: (userMessage, assistantMessage) => stream.setMessages((prev) => [...(prev ?? []), userMessage, assistantMessage]),
    onConversationCreated: setConversationId,
    onUndone: () => {
      if (conversationId) stream.loadMessages(conversationId);
    },
  });
  const live = useLiveVoice({ getConversationId: () => conversationId, refresh: stream.refreshMessagesSilently });

  const { user } = useAuth();
  const skillOptions = useSkillOptions(!!user && isManagerRole(user.role));

  async function createConversation(): Promise<boolean> {
    const created = await convs.create();
    if (!created) return false;
    setConversationId(created.id);
    stream.setMessages([]);
    return true;
  }

  function selectConversation(id: string) {
    if (id === conversationId) return;
    setConversationId(id);
    stream.clearFailed();
    stream.loadMessages(id);
  }

  // context — что открыто у пользователя (панель агента); страница
  // /assistant его не передаёт.
  function send(context?: AgentPageContext, value: string = text) {
    if (stream.send(value, attachments.pending, undefined, context)) {
      if (value === text) setText('');
      attachments.clear();
    }
  }

  return {
    convs,
    conversationId,
    setConversationId,
    text,
    setText,
    stream,
    attachments,
    voice,
    live,
    skillOptions,
    createConversation,
    selectConversation,
    send,
  };
}

export type AssistantSession = ReturnType<typeof useAssistantSession>;
