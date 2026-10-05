'use client';

import { useState, type AnchorHTMLAttributes, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Copy, File, FileSpreadsheet, FileText, Image as ImageIcon } from 'lucide-react';
import type {
  MessagePart as MessagePartData,
  MarkdownPartData,
  ErrorPartData,
  TaskCardData,
  EventCardData,
  ToolActivityData,
  FilePartData,
  TaskStatus,
} from '@ai-task-system/shared-types';
import { STATUS_LABELS } from '@/lib/labels';
import { api } from '@/lib/api';
import { StreamingText, ThinkingLine, ThinkingGroup, EntityCard, FileChip, Alert, Button, StatusBadge } from '@/components/ui';
import { TaskDetailOverlay } from './task-detail-overlay';

// Дизайн-система «Адъютант» (владелец 04.10.2026, implementation.md шаг 7)
// — реестр по part.type остаётся тем же (спека Stage 2 §21), меняются
// только представления. `fresh`/`streaming` приходят от вызывающего экрана
// — только он знает, какое сообщение завершилось В ЭТОМ стриме (не при
// обычной загрузке истории) и какая часть сейчас последняя в стриме.
export function MessagePartRenderer({ part, fresh, streaming }: { part: MessagePartData; fresh?: boolean; streaming?: boolean }) {
  switch (part.type) {
    case 'markdown':
      return <MarkdownPartView data={part.data as MarkdownPartData} streaming={streaming} />;
    case 'task_card':
      return <TaskCardView data={part.data as TaskCardData} fresh={fresh} />;
    case 'event_card':
      return <EventCardView data={part.data as EventCardData} fresh={fresh} />;
    case 'tool_activity':
      return <ToolActivityView data={part.data as ToolActivityData} />;
    case 'error':
      return <ErrorPartView data={part.data as ErrorPartData} />;
    case 'file':
      return <FilePartView data={part.data as FilePartData} />;
    default:
      // Задел на будущий тип части, который этот интерфейс ещё не знает —
      // тихий fallback вместо падения, остальные части сообщения по-прежнему видны.
      return <p className="ds-field-hint">Часть сообщения пока не поддерживается в этом интерфейсе.</p>;
  }
}

// Группирует подряд идущие tool_activity-части под один .ds-think-group
// (agent-motion.md: "Каждая следующая строка выезжает под предыдущей").
export function MessagePartsList({
  parts,
  fresh,
  streamingPartId,
}: {
  parts: MessagePartData[];
  fresh?: boolean;
  streamingPartId?: string | null;
}) {
  const nodes: ReactNode[] = [];
  let toolGroup: MessagePartData[] = [];

  function flushToolGroup() {
    if (toolGroup.length === 0) return;
    nodes.push(
      <ThinkingGroup key={`tool-group-${toolGroup[0].id}`}>
        {toolGroup.map((p) => (
          <MessagePartRenderer key={p.id} part={p} />
        ))}
      </ThinkingGroup>,
    );
    toolGroup = [];
  }

  for (const part of parts) {
    if (part.type === 'tool_activity') {
      toolGroup.push(part);
      continue;
    }
    flushToolGroup();
    nodes.push(<MessagePartRenderer key={part.id} part={part} fresh={fresh} streaming={part.id === streamingPartId} />);
  }
  flushToolGroup();

  return <>{nodes}</>;
}

// Безопасные внешние ссылки — target=_blank без opener. Никакого
// rehype-raw в ReactMarkdown ниже — raw HTML от модели не исполняется,
// только markdown-разметка.
function MarkdownLink(props: AnchorHTMLAttributes<HTMLAnchorElement>) {
  return <a {...props} target="_blank" rel="noopener noreferrer" />;
}

function MarkdownPartView({ data, streaming }: { data: MarkdownPartData; streaming?: boolean }) {
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
      <StreamingText streaming={streaming}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            a: MarkdownLink,
            table: ({ children }) => <div className="ds-table-wrap"><table className="ds-table">{children}</table></div>,
          }}
        >
          {data.content}
        </ReactMarkdown>
      </StreamingText>
      <Button size="sm" variant="ghost" icon={Copy} onClick={copy}>
        {copied ? 'Скопировано' : 'Копировать'}
      </Button>
    </div>
  );
}

const KNOWN_STATUS = new Set(Object.keys(STATUS_LABELS));

function TaskCardView({ data, fresh }: { data: TaskCardData; fresh?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <EntityCard
        kind="task"
        title={data.title}
        status={KNOWN_STATUS.has(data.status) ? <StatusBadge status={data.status as TaskStatus} /> : undefined}
        due={data.dueDate ? new Date(data.dueDate).toLocaleDateString('ru-RU') : undefined}
        assignee={data.assignee?.name}
        source={data.source ? { title: data.source.meetingTitle, ts: data.source.timestamp } : null}
        fresh={fresh}
        onOpen={() => setOpen(true)}
      />
      {open && <TaskDetailOverlay taskId={data.taskId} onClose={() => setOpen(false)} />}
    </>
  );
}

// Без кнопки «Открыть» — в Mini App нет детального оверлея события
// (calendar-screen.tsx показывает только агенду инлайн), строить его —
// отдельная фича календаря, вне рамок этой фазы чата.
function EventCardView({ data, fresh }: { data: EventCardData; fresh?: boolean }) {
  const start = new Date(data.startAt);
  const end = new Date(data.endAt);
  const time = `${start.toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} – ${end.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`;
  return (
    <EntityCard
      kind="event"
      title={data.title}
      time={time}
      location={data.location}
      participants={data.participants.map((p) => p.name)}
      warning={data.warning}
      fresh={fresh}
    />
  );
}

function ToolActivityView({ data }: { data: ToolActivityData }) {
  // `done`/`time` — ToolActivityData (shared-types) сейчас отдаёт только
  // финальный label, без отдельного статуса/длительности, поэтому строка
  // всегда показывается как завершённая; живое "Ищу…" до tool.completed
  // рисует сам стрим, заменяя часть целиком новым data.label.
  return <ThinkingLine label={data.label} done />;
}

function ErrorPartView({ data }: { data: ErrorPartData }) {
  // Без кнопки «Повторить» — это сбой ОДНОГО инструмента внутри уже
  // сохранённого ответа, не обрыв всей отправки (у failedSend на экране
  // retry есть). Повторить именно этот вызов инструмента бэкенд не поддерживает.
  return <Alert tone="danger">{data.message}</Alert>;
}

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

// Не простая <a href> — скачивание требует Authorization-заголовка (JWT),
// которую обычная ссылка не отправит; авторизованный fetch → Blob →
// временный <a download> — стандартный обходной путь для скачки файла,
// защищённого не куки/сессией, а Bearer-токеном.
// Экспортирован — assistant-screen.tsx переиспользует его напрямую для
// показа вложений пользователя внутри его собственного bubble.
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
    <div>
      <FileChip
        icon={<FileIcon mimeType={data.mimeType} size={16} strokeWidth={1.75} />}
        name={data.name}
        size={formatFileSize(data.size)}
        onDownload={downloading ? undefined : download}
      />
      {failed && <span className="ds-field-hint">Не удалось скачать</span>}
    </div>
  );
}
