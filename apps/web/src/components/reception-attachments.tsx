'use client';

import { useState, type ChangeEvent } from 'react';
import { Paperclip } from 'lucide-react';
import type { ReceptionAttachmentItem, UploadedFileInfo } from '@ai-task-system/shared-types';
import { api, ApiError } from '@/lib/api';
import { FileChip } from '@/components/ui';

// Файлы к обращению в приёмную (владелец 22.10.2026). Загрузка — обычный
// POST /files/upload, привязка — fileIds при подаче/правке обращения;
// скачивание — через приёмную (права как на обращение, руководитель видит
// файлы автора).

export const MAX_RECEPTION_ATTACHMENTS = 5;
// Те же форматы, что принимает POST /files/upload (ALLOWED_UPLOAD_MIME_TYPES).
const ACCEPT = '.pdf,.docx,.xlsx,.csv,.txt,.png,.jpg,.jpeg,.webp,.gif';

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}

async function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function ReceptionAttachmentList({ requestId, attachments }: { requestId: string; attachments: ReceptionAttachmentItem[] }) {
  const [failed, setFailed] = useState(false);
  if (attachments.length === 0) return null;

  async function download(a: ReceptionAttachmentItem) {
    setFailed(false);
    try {
      await saveBlob(await api.downloadBlob(`/reception/requests/${requestId}/attachments/${a.fileId}`), a.name);
    } catch {
      setFailed(true);
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {attachments.map((a) => (
          <FileChip key={a.fileId} name={a.name} size={formatFileSize(a.size)} onDownload={() => download(a)} />
        ))}
      </div>
      {failed && <span className="ds-field-hint">Не удалось скачать файл</span>}
    </div>
  );
}

// Выбор файлов в форме обращения: уже приложенные + новые загрузки.
// Снятый свежезагруженный файл удаляется сразу; снятый ранее приложенный
// отвяжется при сохранении обращения.
export function ReceptionAttachmentPicker({
  value,
  onChange,
  disabled,
  initialFileIds,
}: {
  value: ReceptionAttachmentItem[];
  onChange: (next: ReceptionAttachmentItem[]) => void;
  disabled?: boolean;
  initialFileIds: string[];
}) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onFilesSelected(e: ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (picked.length === 0) return;
    const room = MAX_RECEPTION_ATTACHMENTS - value.length;
    if (picked.length > room) {
      setError(`Можно приложить не больше ${MAX_RECEPTION_ATTACHMENTS} файлов`);
      return;
    }
    setError(null);
    setUploading(true);
    const added: ReceptionAttachmentItem[] = [];
    try {
      for (const file of picked) {
        const formData = new FormData();
        formData.append('file', file);
        const info = await api.postForm<UploadedFileInfo>('/files/upload', formData);
        added.push({ fileId: info.fileId, name: info.name, mimeType: info.mimeType, size: info.size });
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось загрузить файл');
    } finally {
      if (added.length) onChange([...value, ...added]);
      setUploading(false);
    }
  }

  function remove(fileId: string) {
    onChange(value.filter((a) => a.fileId !== fileId));
    if (!initialFileIds.includes(fileId)) api.delete(`/files/${fileId}`).catch(() => undefined);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {value.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {value.map((a) => (
            <FileChip key={a.fileId} name={a.name} size={formatFileSize(a.size)} onRemove={disabled ? undefined : () => remove(a.fileId)} />
          ))}
        </div>
      )}
      {value.length < MAX_RECEPTION_ATTACHMENTS && (
        <label
          className="ds-btn ds-btn-secondary"
          style={{ display: 'inline-flex', alignSelf: 'flex-start', cursor: disabled || uploading ? 'default' : 'pointer', opacity: disabled || uploading ? 0.6 : 1 }}
        >
          <Paperclip size={18} strokeWidth={1.75} />
          {uploading ? 'Загружаю…' : 'Прикрепить файл'}
          <input type="file" multiple hidden accept={ACCEPT} disabled={disabled || uploading} onChange={onFilesSelected} />
        </label>
      )}
      {error && <span className="ds-field-hint" style={{ color: 'var(--danger)' }}>{error}</span>}
    </div>
  );
}
