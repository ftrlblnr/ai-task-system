'use client';

import { useRef, useState, type ChangeEvent } from 'react';
import { Paperclip } from 'lucide-react';
import type { UploadedFileInfo } from '@ai-task-system/shared-types';
import { api, ApiError } from '@/lib/api';
import { FileChip, IconButton } from '@/components/ui';

// Вложения к сообщению ассистенту (Phase F): загрузка до отправки, чипы над
// полем ввода. Вынесено из assistant-screen.tsx (редизайн M5, §4.6) без
// изменения поведения.

// Зеркало бэкенд-лимита attachmentIds (@ArrayMaxSize(10)) в
// apps/api/src/assistant/dto/send-message.dto.ts (аудит 16.09.2026).
export const MAX_ATTACHMENTS = 10;
// Зеркало apps/api/src/files/dto/upload-file.dto.ts — accept на <input
// type=file> лишь подсказка браузеру (не замена серверной проверке
// fileFilter/magic-byte, см. file-signature.ts), но избавляет пользователя
// от очевидно бессмысленного выбора файла не из списка.
const ACCEPTED_UPLOAD_MIME_TYPES =
  'application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv,text/plain,image/png,image/jpeg,image/webp,image/gif';

export function usePendingAttachments() {
  // Уже загруженные (POST /files/upload прошёл), но ещё не отправленные
  // вместе с сообщением — можно снять до отправки.
  const [pending, setPending] = useState<UploadedFileInfo[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  async function upload(file: File) {
    if (pending.length >= MAX_ATTACHMENTS) {
      setUploadError(`Нельзя прикрепить больше ${MAX_ATTACHMENTS} файлов к одному сообщению`);
      return;
    }
    setUploading(true);
    setUploadError(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const info = await api.postForm<UploadedFileInfo>('/files/upload', formData);
      setPending((prev) => [...prev, info]);
    } catch (err) {
      setUploadError(err instanceof ApiError ? err.message : 'Не удалось загрузить файл');
    } finally {
      setUploading(false);
    }
  }

  // P1.3 (аудит 16.09.2026, находка #10 — orphan uploads) — раньше снятие
  // вложения крестиком только чистило локальный state, физический файл и
  // запись FileArtifact оставались в БД/на диске навсегда. Fire-and-forget:
  // composer уже не показывает вложение независимо от результата запроса
  // (тот же fail-safe принцип, что и молчаливый пропуск чужого/несуществу-
  // ющего attachmentId на бэкенде) — если DELETE не удался, файл всё равно
  // рано или поздно уберёт FilesCleanupCron.
  function remove(fileId: string) {
    setPending((prev) => prev.filter((a) => a.fileId !== fileId));
    api.delete(`/files/${fileId}`).catch(() => undefined);
  }

  // Отправлены вместе с сообщением — файлы остаются, снимаем только чипы.
  function clear() {
    setPending([]);
  }

  return { pending, uploading, uploadError, upload, remove, clear, full: pending.length >= MAX_ATTACHMENTS };
}

export type PendingAttachments = ReturnType<typeof usePendingAttachments>;

export function PendingAttachmentsRow({ attachments }: { attachments: PendingAttachments }) {
  const { pending, uploading, uploadError, remove } = attachments;
  if (pending.length === 0 && !uploading && !uploadError) return null;
  return (
    <div className="ds-task-meta">
      {pending.map((a) => (
        <FileChip key={a.fileId} name={a.name} onRemove={() => remove(a.fileId)} />
      ))}
      {uploading && <span className="ds-field-hint">Загрузка файла…</span>}
      {uploadError && <span className="ds-field-error">{uploadError}</span>}
    </div>
  );
}

export function AttachButton({ attachments, disabled }: { attachments: PendingAttachments; disabled: boolean }) {
  const inputRef = useRef<HTMLInputElement>(null);

  function onFileSelected(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // даёт выбрать тот же файл повторно позже
    if (file) void attachments.upload(file);
  }

  return (
    <>
      <input ref={inputRef} type="file" hidden accept={ACCEPTED_UPLOAD_MIME_TYPES} onChange={onFileSelected} />
      <IconButton
        icon={Paperclip}
        label="Прикрепить файл"
        size="sm"
        disabled={disabled || attachments.uploading || attachments.full}
        onClick={() => inputRef.current?.click()}
      />
    </>
  );
}
