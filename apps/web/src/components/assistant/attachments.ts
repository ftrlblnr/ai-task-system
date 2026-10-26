'use client';

import { useState, type ChangeEvent } from 'react';
import type { UploadedFileInfo } from '@ai-task-system/shared-types';
import { api, ApiError } from '@/lib/api';

// Вложения к сообщению ассистенту: загрузка до отправки, удаление
// загруженного. Вынесено из app/assistant/page.tsx (W0) без изменения
// поведения.

// Зеркало SendMessageDto (apps/api/src/assistant/dto/send-message.dto.ts)
// — тот же компромисс дублирования, что уже принят в apps/miniapp.
export const MAX_ATTACHMENTS = 10;
export const ACCEPTED_UPLOAD_MIME_TYPES =
  'application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv,text/plain,image/png,image/jpeg,image/webp,image/gif';

export function useAttachments() {
  const [pending, setPending] = useState<UploadedFileInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  async function onFileSelected(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (pending.length >= MAX_ATTACHMENTS) {
      setError(`Нельзя прикрепить больше ${MAX_ATTACHMENTS} файлов к одному сообщению`);
      return;
    }
    setUploading(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const info = await api.postForm<UploadedFileInfo>('/files/upload', formData);
      setPending((prev) => [...prev, info]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось загрузить файл');
    } finally {
      setUploading(false);
    }
  }

  function remove(fileId: string) {
    setPending((prev) => prev.filter((a) => a.fileId !== fileId));
    api.delete(`/files/${fileId}`).catch(() => undefined);
  }

  return { pending, error, uploading, onFileSelected, remove, clear: () => setPending([]) };
}

export type Attachments = ReturnType<typeof useAttachments>;
