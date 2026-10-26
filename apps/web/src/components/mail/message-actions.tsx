'use client';

import type { MailDraftMode, MailDraftView, MailFolderItem, MailMessageAction, MailMessageActionResult } from '@ai-task-system/shared-types';
import { api, ApiError } from '@/lib/api';
import { Select } from '@/components/ui/field';
import { folderLabel, sortFolders } from './folder-list';

// Действия над письмами и общий контекст панели писем. Вынесено из
// app/mail/page.tsx (редизайн web W0).

// Действие над письмами (почтовый клиент, 23.10.2026) — сразу на почтовом
// сервере; ошибки по отдельным письмам возвращаются списком.
export async function runMessageAction(ids: string[], action: MailMessageAction): Promise<string | null> {
  try {
    const res = await api.post<MailMessageActionResult>('/mail/messages/actions', { ids, action });
    if (res.failed.length === 0) return null;
    const first = res.failed[0].error;
    return res.failed.length === 1 ? first : `${first} (писем: ${res.failed.length})`;
  } catch (err) {
    return err instanceof ApiError ? err.message : 'Действие не выполнено';
  }
}

export async function createDraft(mode: MailDraftMode, sourceMessageId?: string): Promise<string> {
  const draft = await api.post<MailDraftView>('/mail/drafts', { mode, sourceMessageId });
  return draft.id;
}

export function MoveSelect({ folders, currentId, onMove, disabled }: { folders: MailFolderItem[]; currentId?: string; onMove: (folderId: string) => void; disabled?: boolean }) {
  return (
    <Select
      aria-label="Переместить в папку"
      value=""
      disabled={disabled}
      onChange={(e) => e.target.value && onMove(e.target.value)}
      style={{ width: 'auto', minWidth: 150 }}
      options={[{ value: '', label: 'Переместить в…' }, ...sortFolders(folders).filter((f) => f.id !== currentId).map((f) => ({ value: f.id, label: f.path.includes(f.delimiter ?? '/') && f.role === 'OTHER' ? f.path : folderLabel(f) }))]}
    />
  );
}

export interface MailPaneContext {
  folders: MailFolderItem[];
  onCompose: (draftId: string) => void;
  onChanged: () => void;
}
