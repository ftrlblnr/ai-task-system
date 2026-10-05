'use client';

import { useEffect, useRef, useState, type ChangeEvent, type FormEvent, type KeyboardEvent } from 'react';
import { Headphones, Mic, Paperclip, Plus, Send, Square } from 'lucide-react';
import type {
  ConversationMessage,
  ConversationSummary,
  FilePartData,
  MessagePart,
  StreamEvent,
  UploadedFileInfo,
  VoiceActionResult,
  VoiceParseResponse,
  VoiceUndoInput,
  VoiceUndoResponse,
} from '@ai-task-system/shared-types';
import { api, ApiError } from '@/lib/api';
import { LiveVoiceClient, type LiveVoicePhase } from '@/lib/live-voice';
import { Protected } from '@/components/protected';
import { MessagePartsList, FilePartView } from '@/components/assistant-message-part';
import { Alert, Button, IconButton, FileChip, UserMessage, AgentMessage, LiveVoiceBar, cx } from '@/components/ui';
import { ASSISTANT_DRAFT_KEY } from '@/components/dashboard/agent-hero';

// Дизайн-система «Адъютант» (владелец 04.10.2026, implementation.md шаг 7)
// — пустой чат: приглашение + 3-4 подсказки-чипа с типовыми поручениями
// (project/README.md: примеры, не настоящие данные). Клик — подставляет
// текст в композер, не отправляет сам: пользователь может его поправить.
const SUGGESTION_PROMPTS = [
  'Поставь задачу Ивану на завтра',
  'Что по задачам на этой неделе?',
  'Какие встречи у меня сегодня?',
  'Кто сейчас перегружен задачами?',
];

// Stage 2, Phase M (Web Assistant parity, 22.09.2026) — desktop-порт
// apps/miniapp/src/components/assistant-screen.tsx. Тот же backend-
// контракт (GET/POST /assistant/conversations[...], SSE .../stream),
// та же транспортная логика (стрим/optimistic-сообщения/retry/вложения/
// голос), но с двумя desktop-специфичными отличиями:
// 1. Список разговоров слева — Mini App всегда берёт conversations[0]
//    (один непрерывный тред на сотрудника), backend уже поддерживает
//    несколько Conversation — здесь это используется по полной (раздел
//    40 спеки Phase M, desktop может позволить себе более богатый UI).
// 2. Никакой Telegram-хаптики/SwipeShell — обычный React-компонент,
//    история грузится на монтирование и при смене conversationId.
const MAX_TEXTAREA_HEIGHT = 160;
// Зеркало SendMessageDto (apps/api/src/assistant/dto/send-message.dto.ts)
// — тот же компромисс дублирования, что уже принят в apps/miniapp.
const MAX_ATTACHMENTS = 10;
const MAX_TEXT_LENGTH = 4000;
const ACCEPTED_UPLOAD_MIME_TYPES =
  'application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv,text/plain,image/png,image/jpeg,image/webp,image/gif';
const NEAR_BOTTOM_THRESHOLD_PX = 80;

// Голос — тот же MediaRecorder-флоу и те же (desktop-формулировки, не
// Telegram-специфичные) сообщения об ошибках доступа к микрофону, что уже
// используются в apps/web/src/app/voice/page.tsx.
const MAX_VOICE_DURATION_MS = 100_000;
const VOICE_MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
const VOICE_UNDO_WINDOW_MS = 30_000;
// Пока идёт живой разговор (GPT-Live), реплики/карточки появляются на сервере
// без участия браузера — лента подтягивается раз в несколько секунд.
const LIVE_POLL_INTERVAL_MS = 2_000;

function pickVoiceMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  return VOICE_MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m));
}

interface VoiceUndoEntry {
  messageId: string;
  partId: string;
  undo: VoiceUndoInput;
}

function buildVoiceUndo(item: VoiceActionResult): VoiceUndoInput | null {
  if (item.type === 'chat' || !item.ok || !item.undoToken) return null;
  return { undoToken: item.undoToken };
}

function newClientRequestId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function optimisticUserMessage(
  conversationId: string,
  clientRequestId: string,
  text: string,
  attachments: UploadedFileInfo[],
): ConversationMessage {
  const parts: MessagePart[] = [{ id: 'optimistic-text', type: 'markdown', order: 0, data: { content: text } }];
  attachments.forEach((a, i) =>
    parts.push({
      id: `optimistic-file-${i}`,
      type: 'file',
      order: i + 1,
      data: { fileId: a.fileId, name: a.name, mimeType: a.mimeType, size: a.size },
    }),
  );
  return {
    id: `optimistic-user-${clientRequestId}`,
    conversationId,
    role: 'user',
    status: 'completed',
    clientRequestId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    parts,
  };
}

function optimisticAssistantMessage(conversationId: string, clientRequestId: string): ConversationMessage {
  return {
    id: `optimistic-assistant-${clientRequestId}`,
    conversationId,
    role: 'assistant',
    status: 'pending',
    clientRequestId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    parts: [],
  };
}

function userBubbleText(m: ConversationMessage): string {
  const part = m.parts[0]?.data as { content?: string } | undefined;
  return part?.content ?? '';
}

function buildLiveParts(toolStates: { name: string; label: string | null }[], liveText: string): MessagePart[] {
  const parts: MessagePart[] = toolStates.map((t, i) => ({
    id: `live-tool-${i}`,
    type: 'tool_activity',
    order: i,
    data: { label: t.label ?? 'Проверяю…' },
  }));
  parts.push({ id: 'live-text', type: 'markdown', order: toolStates.length, data: { content: liveText } });
  return parts;
}

function conversationTitle(c: ConversationSummary): string {
  return c.title?.trim() || 'Новый разговор';
}

export default function AssistantPage() {
  return (
    <Protected>
      <AssistantView />
    </Protected>
  );
}

function AssistantView() {
  const [conversations, setConversations] = useState<ConversationSummary[] | null>(null);
  const [conversationsError, setConversationsError] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [sending, setSending] = useState(false);
  const [failedSend, setFailedSend] = useState<{ clientRequestId: string; text: string; attachments: UploadedFileInfo[] } | null>(
    null,
  );
  const chatRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);
  const [showJumpButton, setShowJumpButton] = useState(false);
  // Дизайн-система «Адъютант» (владелец 04.10.2026, implementation.md шаг 7)
  // — кнопка «Остановить ответ» в Composer; AbortController, не React state
  // (нужен только внутри текущего send(), ре-рендер не требуется).
  const sendAbortRef = useRef<AbortController | null>(null);
  const userStoppedRef = useRef(false);
  // "Создано только что" (материализация, agent-motion.md) — id сообщений,
  // завершённых ЖИВЫМ стримом в этой сессии. Не React state: мутируется в
  // handleEvent синхронно с setMessages из того же вызова, тот же ре-рендер
  // подхватывает оба изменения; при обычной загрузке истории (loadMessages)
  // сюда ничего не попадает, поэтому старые сообщения никогда не "фреш".
  const freshMessageIdsRef = useRef<Set<string>>(new Set());

  const [pendingAttachments, setPendingAttachments] = useState<UploadedFileInfo[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [voicePhase, setVoicePhase] = useState<'idle' | 'recording' | 'processing'>('idle');
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [voiceElapsedSec, setVoiceElapsedSec] = useState(0);
  const [voiceUndos, setVoiceUndos] = useState<VoiceUndoEntry[]>([]);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const voiceStreamRef = useRef<MediaStream | null>(null);
  const voiceChunksRef = useRef<Blob[]>([]);
  const voiceAutoStopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const voiceTickTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Stage 2, Phase Q — живой голос (GPT-Live по WebRTC). Кнопка видна, только
  // если бэкенд включил фичу (GET /live/status).
  const [liveEnabled, setLiveEnabled] = useState(false);
  const [livePhase, setLivePhase] = useState<LiveVoicePhase>('idle');
  const [liveCaption, setLiveCaption] = useState<{ who: 'user' | 'assistant'; text: string } | null>(null);
  const [liveError, setLiveError] = useState<string | null>(null);
  const liveClientRef = useRef<LiveVoiceClient | null>(null);
  const liveActive = livePhase !== 'idle';
  const conversationIdRef = useRef<string | null>(null);
  conversationIdRef.current = conversationId;

  useEffect(() => {
    api
      .get<{ enabled: boolean }>('/live/status')
      .then((s) => setLiveEnabled(s.enabled))
      .catch(() => setLiveEnabled(false));
  }, []);

  // Тихое обновление ленты (без setMessages(null) — без «мигающего» Loading).
  function refreshMessagesSilently() {
    const id = conversationIdRef.current;
    if (!id) return;
    api
      .get<ConversationMessage[]>(`/assistant/conversations/${id}/messages`)
      .then((msgs) => {
        if (conversationIdRef.current !== id) return;
        setMessages((prev) => {
          const last = (list: ConversationMessage[] | null) => list?.[list.length - 1];
          const a = last(prev);
          const b = last(msgs);
          const unchanged = prev && prev.length === msgs.length && a?.id === b?.id && a?.updatedAt === b?.updatedAt;
          return unchanged ? prev : msgs;
        });
      })
      .catch(() => undefined);
  }

  useEffect(() => {
    if (livePhase !== 'live') return;
    const timer = setInterval(refreshMessagesSilently, LIVE_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [livePhase]);

  useEffect(() => {
    return () => {
      void liveClientRef.current?.stop();
    };
  }, []);

  function startLive() {
    setLiveError(null);
    setLiveCaption(null);
    if (!liveClientRef.current) {
      liveClientRef.current = new LiveVoiceClient({
        onPhase: (phase) => {
          setLivePhase(phase);
          // Финальная подтяжка ленты после завершения разговора.
          if (phase === 'idle') refreshMessagesSilently();
        },
        onCaption: (who, delta) =>
          setLiveCaption((prev) => (prev && prev.who === who ? { who, text: (prev.text + delta).slice(-300) } : { who, text: delta })),
        onError: setLiveError,
      });
    }
    void liveClientRef.current.start(conversationIdRef.current);
  }

  function stopLive() {
    void liveClientRef.current?.stop();
  }

  useEffect(() => {
    return () => {
      if (voiceAutoStopTimerRef.current) clearTimeout(voiceAutoStopTimerRef.current);
      if (voiceTickTimerRef.current) clearInterval(voiceTickTimerRef.current);
      voiceStreamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  async function startVoiceRecording() {
    setVoiceError(null);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      const name = err instanceof DOMException ? err.name : '';
      if (name === 'NotAllowedError') {
        setVoiceError('Доступ к микрофону запрещён — разрешите его в настройках браузера для этого сайта.');
      } else if (name === 'NotFoundError') {
        setVoiceError('Микрофон не найден на этом устройстве.');
      } else {
        setVoiceError('Не удалось получить доступ к микрофону.');
      }
      return;
    }

    const mimeType = pickVoiceMimeType();
    const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    voiceChunksRef.current = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) voiceChunksRef.current.push(e.data);
    };
    recorder.onstop = () => void handleVoiceStop();

    voiceStreamRef.current = stream;
    recorderRef.current = recorder;
    recorder.start();

    setVoiceElapsedSec(0);
    setVoicePhase('recording');
    voiceTickTimerRef.current = setInterval(() => setVoiceElapsedSec((s) => s + 1), 1000);
    voiceAutoStopTimerRef.current = setTimeout(() => stopVoiceRecording(), MAX_VOICE_DURATION_MS);
  }

  function stopVoiceRecording() {
    if (voiceAutoStopTimerRef.current) clearTimeout(voiceAutoStopTimerRef.current);
    if (voiceTickTimerRef.current) clearInterval(voiceTickTimerRef.current);
    voiceAutoStopTimerRef.current = null;
    voiceTickTimerRef.current = null;
    recorderRef.current?.stop();
    voiceStreamRef.current?.getTracks().forEach((t) => t.stop());
  }

  async function handleVoiceStop() {
    setVoicePhase('processing');
    try {
      const actualMimeType = recorderRef.current?.mimeType || 'audio/webm';
      const blob = new Blob(voiceChunksRef.current, { type: actualMimeType });
      const ext = actualMimeType.includes('mp4') ? 'm4a' : actualMimeType.includes('ogg') ? 'ogg' : 'webm';
      const formData = new FormData();
      formData.append('audio', blob, `voice.${ext}`);
      formData.append('clientRequestId', newClientRequestId());
      if (conversationId) formData.append('conversationId', conversationId);

      const response = await api.postForm<VoiceParseResponse>('/voice/parse', formData);

      if (response.userMessage && response.assistantMessage) {
        const { userMessage, assistantMessage } = response;
        setMessages((prev) => [...(prev ?? []), userMessage, assistantMessage]);
        if (!conversationId && response.conversationId) setConversationId(response.conversationId);

        const newUndos: VoiceUndoEntry[] = [];
        response.results.forEach((item, i) => {
          const undo = buildVoiceUndo(item);
          const part = assistantMessage.parts[i];
          if (undo && part) newUndos.push({ messageId: assistantMessage.id, partId: part.id, undo });
        });
        if (newUndos.length > 0) {
          setVoiceUndos((prev) => [...prev, ...newUndos]);
          setTimeout(() => {
            setVoiceUndos((prev) => prev.filter((u) => !newUndos.includes(u)));
          }, VOICE_UNDO_WINDOW_MS);
        }
      }
    } catch (err) {
      setVoiceError(err instanceof ApiError ? err.message : 'Не удалось обработать голосовое сообщение.');
    } finally {
      setVoicePhase('idle');
    }
  }

  async function performVoiceUndo(entry: VoiceUndoEntry) {
    setVoiceUndos((prev) => prev.filter((u) => u !== entry));
    try {
      await api.post<VoiceUndoResponse>('/voice/undo', entry.undo);
    } finally {
      if (conversationId) loadMessages(conversationId);
    }
  }

  async function onFileSelected(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (pendingAttachments.length >= MAX_ATTACHMENTS) {
      setUploadError(`Нельзя прикрепить больше ${MAX_ATTACHMENTS} файлов к одному сообщению`);
      return;
    }
    setUploading(true);
    setUploadError(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const info = await api.postForm<UploadedFileInfo>('/files/upload', formData);
      setPendingAttachments((prev) => [...prev, info]);
    } catch (err) {
      setUploadError(err instanceof ApiError ? err.message : 'Не удалось загрузить файл');
    } finally {
      setUploading(false);
    }
  }

  function removePendingAttachment(fileId: string) {
    setPendingAttachments((prev) => prev.filter((a) => a.fileId !== fileId));
    api.delete(`/files/${fileId}`).catch(() => undefined);
  }

  // Первая загрузка страницы — выбирает и грузит переписку выбранного/
  // первого разговора. Не путать с refreshConversationTitles() ниже
  // (только список слева, без побочных loadMessages/setConversationId).
  function loadConversations() {
    api
      .get<ConversationSummary[]>('/assistant/conversations')
      .then((list) => {
        setConversations(list);
        setConversationsError(null);
        const targetId = list[0]?.id ?? null;
        if (targetId) {
          setConversationId(targetId);
          loadMessages(targetId);
        } else {
          setMessages([]);
        }
      })
      .catch((err) => setConversationsError(err instanceof ApiError ? err.message : 'Не удалось загрузить список разговоров'));
  }

  // После первого ответа в разговоре сервер сам выводит его заголовок из
  // первой реплики — обновляем только список слева (заголовок мог
  // смениться), НЕ дёргаем loadMessages/setConversationId: переписка уже
  // корректно обновлена самим стримом (message.completed), повторная
  // загрузка означала бы лишний "мигающий" Loading прямо после ответа.
  function refreshConversationTitles() {
    api
      .get<ConversationSummary[]>('/assistant/conversations')
      .then(setConversations)
      .catch(() => undefined);
  }

  function loadMessages(id: string) {
    setMessages(null);
    api
      .get<ConversationMessage[]>(`/assistant/conversations/${id}/messages`)
      .then((msgs) => {
        setMessages(msgs);
        setLoadError(null);
      })
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : 'Не удалось загрузить переписку'));
  }

  function selectConversation(id: string) {
    if (id === conversationId) return;
    setConversationId(id);
    setFailedSend(null);
    loadMessages(id);
  }

  async function createConversation() {
    try {
      const created = await api.post<ConversationSummary>('/assistant/conversations', {});
      setConversations((prev) => [created, ...(prev ?? [])]);
      setConversationId(created.id);
      setMessages([]);
    } catch (err) {
      setConversationsError(err instanceof ApiError ? err.message : 'Не удалось создать разговор');
    }
  }

  useEffect(() => {
    loadConversations();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // «Стол руководителя» (ТЗ v1.0, 05.10.2026, раздел 6.2) — черновик из
  // AgentHero передаётся через sessionStorage с одноразовым ключом (не URL),
  // читается и сразу удаляется здесь. Если в композере уже что-то набрано —
  // спрашиваем, не теряем молча (простой confirm — отдельного более богатого
  // UI для этого в проекте пока нет).
  useEffect(() => {
    let raw: string | null = null;
    try {
      raw = sessionStorage.getItem(ASSISTANT_DRAFT_KEY);
    } catch {
      return;
    }
    if (!raw) return;
    sessionStorage.removeItem(ASSISTANT_DRAFT_KEY);
    let draftText = '';
    try {
      draftText = (JSON.parse(raw) as { text?: string }).text?.trim() ?? '';
    } catch {
      return;
    }
    if (!draftText) return;

    // Чтение одноразового sessionStorage-ключа на монтировании — синхронизация
    // с внешней системой, не подстройка под изменившийся проп (тот же случай,
    // что уже разбирался в apps/web/src/lib/auth-context.tsx).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setText((prev) => {
      if (prev.trim() && !window.confirm('Заменить текущий черновик текстом со «Стола руководителя»?')) {
        return prev;
      }
      return draftText;
    });
    requestAnimationFrame(() => textareaRef.current?.focus());
    // eslint-disable-next-line react-hooks/exhaustive-deps -- один раз на монтирование, читает одноразовый sessionStorage-ключ
  }, []);

  useEffect(() => {
    const el = chatRef.current;
    if (!el) return;
    function onScroll() {
      if (!el) return;
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_THRESHOLD_PX;
      isNearBottomRef.current = nearBottom;
      setShowJumpButton((prev) => (prev === !nearBottom ? prev : !nearBottom));
    }
    el.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => el.removeEventListener('scroll', onScroll);
  }, [conversationId]);

  useEffect(() => {
    if (!isNearBottomRef.current) return;
    chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  function scrollToBottom() {
    chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight, behavior: 'smooth' });
    isNearBottomRef.current = true;
    setShowJumpButton(false);
  }

  async function send(overrideText?: string, overrideClientRequestId?: string, overrideAttachments?: UploadedFileInfo[]) {
    const isRetry = Boolean(overrideClientRequestId);
    const value = (overrideText ?? text).trim();
    if (!value || sending || !conversationId) return;

    const attachments = overrideAttachments ?? pendingAttachments;
    const clientRequestId = overrideClientRequestId ?? newClientRequestId();
    const assistantPlaceholderId = `optimistic-assistant-${clientRequestId}`;

    setSending(true);
    setFailedSend(null);
    if (!isRetry) {
      setText('');
      setPendingAttachments([]);
    }

    setMessages((prev) => {
      const base = prev ?? [];
      const withUser = isRetry ? base : [...base, optimisticUserMessage(conversationId, clientRequestId, value, attachments)];
      return [...withUser, optimisticAssistantMessage(conversationId, clientRequestId)];
    });

    let liveText = '';
    const toolStates: { name: string; label: string | null }[] = [];
    let terminal = false;

    function renderLive() {
      setMessages((prev) =>
        (prev ?? []).map((m) =>
          m.id === assistantPlaceholderId ? { ...m, status: 'streaming', parts: buildLiveParts(toolStates, liveText) } : m,
        ),
      );
    }

    let renderScheduled = false;
    function scheduleRender() {
      if (renderScheduled) return;
      renderScheduled = true;
      requestAnimationFrame(() => {
        renderScheduled = false;
        renderLive();
      });
    }

    function handleEvent(event: StreamEvent) {
      switch (event.event) {
        case 'part.started':
          liveText = '';
          scheduleRender();
          break;
        case 'part.delta':
          liveText += event.delta;
          scheduleRender();
          break;
        case 'tool.started':
          toolStates.push({ name: event.tool, label: null });
          scheduleRender();
          break;
        case 'tool.completed': {
          const pending = toolStates.find((t) => t.name === event.tool && t.label === null);
          if (pending) pending.label = event.label;
          scheduleRender();
          break;
        }
        case 'message.completed':
          terminal = true;
          freshMessageIdsRef.current.add(event.message.id);
          setMessages((prev) => (prev ?? []).filter((m) => m.id !== assistantPlaceholderId).concat(event.message));
          refreshConversationTitles();
          break;
        case 'message.failed':
          terminal = true;
          setMessages((prev) => (prev ?? []).filter((m) => m.id !== assistantPlaceholderId));
          setFailedSend({ clientRequestId, text: value, attachments });
          break;
        case 'message.started':
          setMessages((prev) => (prev ?? []).map((m) => (m.id === `optimistic-user-${clientRequestId}` ? event.userMessage : m)));
          break;
      }
    }

    const controller = new AbortController();
    sendAbortRef.current = controller;
    userStoppedRef.current = false;

    try {
      const response = await api.postStream(
        `/assistant/conversations/${conversationId}/messages/stream`,
        { text: value, clientRequestId, attachmentIds: attachments.map((a) => a.fileId) },
        controller.signal,
      );
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Поток ответа недоступен');
      const decoder = new TextDecoder();
      let buffer = '';

      for (;;) {
        const { done, value: chunk } = await reader.read();
        if (chunk) buffer += decoder.decode(chunk, { stream: true });
        let frameEnd: number;
        while ((frameEnd = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, frameEnd);
          buffer = buffer.slice(frameEnd + 2);
          const dataLine = frame.split('\n').find((l) => l.startsWith('data:'));
          if (!dataLine) continue;
          handleEvent(JSON.parse(dataLine.slice(5).trim()) as StreamEvent);
        }
        if (done) break;
      }

      if (!terminal) {
        setMessages((prev) => (prev ?? []).filter((m) => m.id !== assistantPlaceholderId));
        setFailedSend({ clientRequestId, text: value, attachments });
      }
    } catch (err) {
      // Остановлено самим пользователем (кнопка «Остановить ответ») — не
      // сбой: оставляем накопленный к этому моменту текст как обычный
      // завершённый ответ, без «Ответ был прерван» / «Повторить».
      if (userStoppedRef.current) {
        terminal = true;
        setMessages((prev) =>
          (prev ?? []).map((m) =>
            m.id === assistantPlaceholderId ? { ...m, status: 'completed', parts: buildLiveParts(toolStates, liveText) } : m,
          ),
        );
      } else if (!(err instanceof DOMException && err.name === 'AbortError')) {
        setMessages((prev) => (prev ?? []).filter((m) => m.id !== assistantPlaceholderId));
        setFailedSend({ clientRequestId, text: value, attachments });
      }
    } finally {
      sendAbortRef.current = null;
      setSending(false);
    }
  }

  function stopSending() {
    userStoppedRef.current = true;
    sendAbortRef.current?.abort();
  }

  function onComposerKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  function onTextareaInput(e: FormEvent<HTMLTextAreaElement>) {
    const el = e.currentTarget;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`;
  }

  const composerDisabled = liveActive || voicePhase !== 'idle' || !conversationId;
  const isVoiceProcessing = voicePhase === 'processing';

  return (
    <div className="assistant-layout">
      <aside className="assistant-conversations-sidebar">
        <Button variant="secondary" icon={Plus} onClick={createConversation}>
          Новый разговор
        </Button>
        {conversationsError && <Alert tone="danger">{conversationsError}</Alert>}
        {!conversations ? (
          <p className="ds-field-hint">Загрузка…</p>
        ) : (
          <div className="assistant-conversation-list">
            {conversations.map((c) => (
              <button
                key={c.id}
                type="button"
                className={`assistant-conversation-item ${c.id === conversationId ? 'active' : ''}`}
                onClick={() => selectConversation(c.id)}
              >
                {conversationTitle(c)}
              </button>
            ))}
            {conversations.length === 0 && <p className="ds-field-hint">Разговоров пока нет</p>}
          </div>
        )}
      </aside>

      <div className="assistant-chat-pane">
        <div className="ds-thread" ref={chatRef}>
          {!messages ? (
            <p className="ds-field-hint">Загрузка…</p>
          ) : (
            <>
              {messages.length === 0 && (
                <div style={{ textAlign: 'center', padding: '48px 16px' }}>
                  {/* "display" — типографика только для этого места и экрана
                      входа (project/README.md); отдельного CSS-класса под
                      неё нет нигде в ds.css (значения баковые per-компонент,
                      не utility-классы), поэтому здесь — инлайн по tokens.json. */}
                  <p style={{ margin: '0 0 8px', fontSize: 32, lineHeight: '38px', fontWeight: 650, letterSpacing: '-0.025em' }}>
                    Чем помочь?
                  </p>
                  <p className="ds-field-hint" style={{ margin: '0 0 16px' }}>
                    Спросите что-нибудь текстом или надиктуйте задачу/встречу голосом.
                  </p>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
                    {SUGGESTION_PROMPTS.map((p) => (
                      <button key={p} type="button" className="ds-chip" onClick={() => setText(p)}>
                        {p}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {messages.map((m) => {
                if (m.role === 'user') {
                  return (
                    <UserMessage
                      key={m.id}
                      attachments={m.parts
                        .filter((p) => p.type === 'file')
                        .map((p) => <FilePartView key={p.id} data={p.data as FilePartData} />)}
                    >
                      {userBubbleText(m)}
                    </UserMessage>
                  );
                }
                const fresh = freshMessageIdsRef.current.has(m.id);
                const lastPart = m.parts[m.parts.length - 1];
                const streamingPartId = m.status === 'streaming' && lastPart?.type === 'markdown' ? lastPart.id : null;
                return (
                  <AgentMessage key={m.id} state={m.status === 'completed' ? 'done' : m.status === 'failed' ? 'error' : m.status} actions={false}>
                    {m.status === 'pending' ? null : (
                      <MessagePartsList parts={m.parts} fresh={fresh} streamingPartId={streamingPartId} />
                    )}
                    {m.parts.map((part) => {
                      const undo = voiceUndos.find((u) => u.messageId === m.id && u.partId === part.id);
                      if (!undo) return null;
                      return (
                        <div key={`undo-${part.id}`} className="voice-confirm-actions">
                          <Button size="sm" variant="ghost" onClick={() => performVoiceUndo(undo)}>
                            Отменить
                          </Button>
                        </div>
                      );
                    })}
                  </AgentMessage>
                );
              })}
              {loadError && <Alert tone="danger">{loadError}</Alert>}
            </>
          )}
          {failedSend && (
            <Alert
              tone="danger"
              action={
                <Button size="sm" onClick={() => send(failedSend.text, failedSend.clientRequestId, failedSend.attachments)}>
                  Повторить
                </Button>
              }
            >
              Ответ был прерван.
            </Alert>
          )}
          {showJumpButton && (
            <button type="button" className="assistant-scroll-down" onClick={scrollToBottom}>
              ↓ Новые сообщения
            </button>
          )}
        </div>

        {voiceError && <Alert tone="danger">{voiceError}</Alert>}
        {liveError && <Alert tone="danger">{liveError}</Alert>}

        <div className={cx('ds-composer', sending && 'is-busy')}>
          {liveActive && (
            <LiveVoiceBar
              status={livePhase === 'connecting' ? 'Подключаюсь…' : livePhase === 'closing' ? 'Завершаю…' : 'Идёт разговор'}
              caption={liveCaption ? `${liveCaption.who === 'user' ? 'Вы' : 'Ассистент'}: ${liveCaption.text}` : ''}
              amp={null}
              onStop={stopLive}
              stopDisabled={livePhase === 'closing'}
            />
          )}
          {(pendingAttachments.length > 0 || uploading || uploadError) && (
            <div className="ds-task-meta">
              {pendingAttachments.map((a) => (
                <FileChip key={a.fileId} name={a.name} onRemove={() => removePendingAttachment(a.fileId)} />
              ))}
              {uploading && <span className="ds-field-hint">Загрузка файла…</span>}
              {uploadError && <span className="ds-field-error">{uploadError}</span>}
            </div>
          )}
          <input ref={fileInputRef} type="file" hidden accept={ACCEPTED_UPLOAD_MIME_TYPES} onChange={onFileSelected} />
          <textarea
            ref={textareaRef}
            rows={1}
            placeholder="Напишите задачу, вопрос или поручение…"
            aria-label="Сообщение ассистенту"
            value={text}
            disabled={sending || composerDisabled}
            maxLength={MAX_TEXT_LENGTH}
            onChange={(e) => setText(e.target.value)}
            onInput={onTextareaInput}
            onKeyDown={onComposerKeyDown}
          />
          <div className="ds-composer-row">
            <IconButton
              icon={Paperclip}
              label="Прикрепить файл"
              size="sm"
              disabled={sending || uploading || composerDisabled || pendingAttachments.length >= MAX_ATTACHMENTS}
              onClick={() => fileInputRef.current?.click()}
            />
            {voicePhase === 'recording' ? (
              <IconButton icon={Square} label="Остановить запись" size="sm" onClick={stopVoiceRecording} />
            ) : (
              <IconButton
                icon={Mic}
                label="Надиктовать"
                size="sm"
                disabled={sending || uploading || composerDisabled || isVoiceProcessing}
                onClick={startVoiceRecording}
              />
            )}
            {liveEnabled && voicePhase === 'idle' && (
              <IconButton
                icon={Headphones}
                label="Живой голос"
                size="sm"
                disabled={sending || uploading || liveActive || !conversationId}
                onClick={startLive}
              />
            )}
            <span className="ds-spacer" />
            {voicePhase === 'recording' && (
              <span className="mono" style={{ fontWeight: 600, fontSize: 13 }}>
                {String(Math.floor(voiceElapsedSec / 60)).padStart(2, '0')}:{String(voiceElapsedSec % 60).padStart(2, '0')}
              </span>
            )}
            {text.length > MAX_TEXT_LENGTH - 200 && (
              <span className={cx('ds-composer-count', text.length > MAX_TEXT_LENGTH && 'is-over')}>
                {text.length}/{MAX_TEXT_LENGTH}
              </span>
            )}
            {sending ? (
              <IconButton icon={Square} label="Остановить ответ" variant="outline" size="sm" onClick={stopSending} />
            ) : (
              <IconButton
                icon={Send}
                label="Отправить"
                variant="primary"
                size="sm"
                disabled={!text.trim() || composerDisabled}
                onClick={() => send()}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
