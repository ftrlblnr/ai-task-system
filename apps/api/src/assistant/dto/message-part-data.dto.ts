// Зеркало packages/shared-types (проект дублирует типы api/web вручную —
// тот же приём, что уже в voice/dto/voice-draft-response.dto.ts; apps/api
// не подключает @ai-task-system/shared-types как зависимость). Формы данных
// для MessagePart — Stage 2 §5.

export interface MarkdownPartData {
  content: string;
}

export interface ErrorPartData {
  message: string;
}

export interface TaskCardData {
  taskId: string;
  title: string;
  status: string;
  dueDate: string | null;
  assignee: { id: string; name: string } | null;
}

export interface EventCardData {
  eventId: string;
  title: string;
  startAt: string;
  endAt: string;
  location: string | null;
  participants: { id: string; name: string }[];
}

export interface ToolActivityData {
  label: string;
}

// Phase F — вложение (upload), см. apps/api/src/files/. fileId — реальный
// FileArtifact.id, скачивание идёт через GET /files/:id/download (проверка
// владения там же, а не полагается на то, что fileId сюда мог попасть
// только легитимно).
export interface FilePartData {
  fileId: string;
  name: string;
  mimeType: string;
  size: number;
}
