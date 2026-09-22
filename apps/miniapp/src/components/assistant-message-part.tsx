'use client';

import { useState, type AnchorHTMLAttributes } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Copy, Download, ExternalLink, File, FileAudio, FileSpreadsheet, FileText, Image as ImageIcon } from 'lucide-react';
import type {
  MessagePart as MessagePartData,
  MarkdownPartData,
  ErrorPartData,
  TaskCardData,
  EventCardData,
  ToolActivityData,
  FilePartData,
} from '@ai-task-system/shared-types';
import { STATUS_LABELS } from '@/lib/labels';
import { api } from '@/lib/api';
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
    case 'file':
      return <FilePartView data={part.data as FilePartData} />;
    default:
      // Задел на будущий тип части, который этот интерфейс ещё не знает —
      // тихий fallback вместо падения, остальные части сообщения по-прежнему видны.
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
      {data.source && (
        <div className="assistant-card-source">
          <FileAudio size={12} strokeWidth={2.2} />
          <span>{data.source.meetingTitle}</span>
          {data.source.timestamp && <span className="mono">{data.source.timestamp}</span>}
        </div>
      )}
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
      {data.warning && <div className="assistant-card-warning">⚠ {data.warning}</div>}
    </div>
  );
}

function ToolActivityView({ data }: { data: ToolActivityData }) {
  return <div className="assistant-tool-activity">{data.label}</div>;
}

function ErrorPartView({ data }: { data: ErrorPartData }) {
  return <div className="assistant-error">{data.message}</div>;
}

// Отдельный компонент, а не функция, возвращающая ссылку на компонент
// (react-hooks/static-components — "Cannot create components during
// render": выбор ссылки на компонент прямо в теле рендера FilePartView
// не считается объявлением компонента "снаружи", даже если сами варианты
// статичны) — так однозначно нет динамически выбираемого JSX-тега.
function FileIcon({ mimeType, size, strokeWidth }: { mimeType: string; size: number; strokeWidth: number }) {
  if (mimeType.startsWith('image/')) return <ImageIcon size={size} strokeWidth={strokeWidth} />;
  if (mimeType.includes('spreadsheet') || mimeType === 'text/csv') return <FileSpreadsheet size={size} strokeWidth={strokeWidth} />;
  if (mimeType === 'application/pdf' || mimeType.includes('wordprocessing') || mimeType === 'text/plain') {
    return <FileText size={size} strokeWidth={strokeWidth} />;
  }
  return <File size={size} strokeWidth={strokeWidth} />;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}

// Не простая <a href> — скачивание требует Authorization-заголовка
// (JWT), которую обычная ссылка не отправит; авторизованный fetch →
// Blob → временный <a download> — стандартный обходной путь для скачки
// файла, защищённого не куки/сессией, а Bearer-токеном.
// Экспортирован — assistant-screen.tsx переиспользует его напрямую для
// показа вложений пользователя внутри его собственного bubble (реестр
// MessagePartRenderer выше рассчитан на document-flow вывод ассистента,
// не на компактный вид внутри цветного bubble).
export function FilePartView({ data }: { data: FilePartData }) {
  const [downloading, setDownloading] = useState(false);
  const [failed, setFailed] = useState(false);

  async function download() {
    setDownloading(true);
    setFailed(false);
    try {
      const blob = await api.downloadBlob(`/files/${data.fileId}/download`);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = data.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setFailed(true);
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="assistant-file-part">
      <FileIcon mimeType={data.mimeType} size={22} strokeWidth={1.7} />
      <div className="assistant-file-info">
        <div className="assistant-file-name">{data.name}</div>
        <div className="assistant-file-size">{formatFileSize(data.size)}</div>
      </div>
      <button type="button" className="assistant-file-download" onClick={download} disabled={downloading} aria-label="Скачать">
        <Download size={16} strokeWidth={2} />
      </button>
      {failed && <span className="hint">Не удалось скачать</span>}
    </div>
  );
}
