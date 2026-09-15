'use client';

import { useState, type AnchorHTMLAttributes } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Copy, ExternalLink } from 'lucide-react';
import type {
  MessagePart as MessagePartData,
  MarkdownPartData,
  ErrorPartData,
  TaskCardData,
  EventCardData,
  ToolActivityData,
} from '@ai-task-system/shared-types';
import { STATUS_LABELS } from '@/lib/labels';
import { TaskDetailOverlay } from './task-detail-overlay';

// Реестр компонентов по типу части (спека Stage 2 §21) — новый тип части
// добавляется веткой в switch ниже, без изменений AssistantScreen.
// MessagePart['data'] — не настоящий discriminated union (одна и та же
// форма для всех типов на уровне TS), поэтому каждая ветка кастует data к
// своей форме сама — сама форма гарантирована бэкендом (assistant-render.ts
// формирует part.type и part.data вместе, см. Phase C).
export function MessagePartRenderer({ part }: { part: MessagePartData }) {
  switch (part.type) {
    case 'markdown':
      return <MarkdownPartView data={part.data as MarkdownPartData} />;
    case 'task_card':
      return <TaskCardView data={part.data as TaskCardData} />;
    case 'event_card':
      return <EventCardView data={part.data as EventCardData} />;
    case 'tool_activity':
      return <ToolActivityView data={part.data as ToolActivityData} />;
    case 'error':
      return <ErrorPartView data={part.data as ErrorPartData} />;
    default:
      // 'file' — форма данных появится в Phase F (upload/generation).
      // Тихий fallback вместо падения — часть ответа просто не отрисуется,
      // остальные части сообщения по-прежнему видны.
      return <p className="hint">Часть сообщения пока не поддерживается в этом интерфейсе.</p>;
  }
}

// Безопасные внешние ссылки — target=_blank без opener (спека §22).
// Никакого rehype-raw в ReactMarkdown ниже — raw HTML от модели не
// исполняется, только markdown-разметка.
function MarkdownLink(props: AnchorHTMLAttributes<HTMLAnchorElement>) {
  return <a {...props} target="_blank" rel="noopener noreferrer" />;
}

function MarkdownPartView({ data }: { data: MarkdownPartData }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(data.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Буфер обмена недоступен (нет разрешения/не https) — молча
      // игнорируем, кнопка просто не сработает визуально; не критичная
      // функция, не стоит показывать пользователю отдельную ошибку.
    }
  }

  return (
    <div>
      <div className="assistant-markdown">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            a: MarkdownLink,
            table: ({ children }) => <div className="assistant-markdown-table-wrap"><table>{children}</table></div>,
          }}
        >
          {data.content}
        </ReactMarkdown>
      </div>
      <button type="button" className="assistant-copy-btn" onClick={copy}>
        <Copy size={12} strokeWidth={2.2} />
        {copied ? 'Скопировано' : 'Копировать'}
      </button>
    </div>
  );
}

function TaskCardView({ data }: { data: TaskCardData }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="assistant-card">
      <div className="assistant-card-title">{data.title}</div>
      <div className="assistant-card-meta">
        <span>{STATUS_LABELS[data.status as keyof typeof STATUS_LABELS] ?? data.status}</span>
        {data.dueDate && <span>до {new Date(data.dueDate).toLocaleDateString('ru-RU')}</span>}
        {data.assignee && <span>{data.assignee.name}</span>}
      </div>
      <button type="button" className="assistant-card-open" onClick={() => setOpen(true)}>
        <ExternalLink size={12} strokeWidth={2.2} style={{ marginRight: 4 }} />
        Открыть
      </button>
      {open && <TaskDetailOverlay taskId={data.taskId} onClose={() => setOpen(false)} />}
    </div>
  );
}

// Без кнопки «Открыть» — в Mini App нет детального оверлея события
// (calendar-screen.tsx показывает только агенду инлайн), строить его —
// отдельная фича календаря, вне рамок этой фазы чата.
function EventCardView({ data }: { data: EventCardData }) {
  const start = new Date(data.startAt);
  const end = new Date(data.endAt);
  const time = `${start.toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} – ${end.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`;
  return (
    <div className="assistant-card">
      <div className="assistant-card-title">{data.title}</div>
      <div className="assistant-card-meta">
        <span>{time}</span>
        {data.location && <span>{data.location}</span>}
      </div>
      {data.participants.length > 0 && (
        <div className="assistant-chip-row">
          {data.participants.map((p) => (
            <span key={p.id} className="assistant-chip">
              {p.name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function ToolActivityView({ data }: { data: ToolActivityData }) {
  return <div className="assistant-tool-activity">{data.label}</div>;
}

function ErrorPartView({ data }: { data: ErrorPartData }) {
  return <div className="assistant-error">{data.message}</div>;
}
