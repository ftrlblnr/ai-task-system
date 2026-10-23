'use client';

import { Archive, File, Folder, Inbox, Send, ShieldAlert, Trash2, type LucideIcon } from 'lucide-react';
import type { MailFolderItem, MailFolderRole } from '@ai-task-system/shared-types';

// Папки ящика (владелец 23.10.2026: «как в Outlook»): системные — сверху в
// привычном порядке и по-русски, свои — деревом по разделителю пути.

const ROLE_ORDER: MailFolderRole[] = ['INBOX', 'DRAFTS', 'SENT', 'ARCHIVE', 'JUNK', 'TRASH'];

const ROLE_LABELS: Record<MailFolderRole, string> = {
  INBOX: 'Входящие',
  DRAFTS: 'Черновики',
  SENT: 'Отправленные',
  ARCHIVE: 'Архив',
  JUNK: 'Спам',
  TRASH: 'Корзина',
  OTHER: '',
};

const ROLE_ICONS: Record<MailFolderRole, LucideIcon> = {
  INBOX: Inbox,
  DRAFTS: File,
  SENT: Send,
  ARCHIVE: Archive,
  JUNK: ShieldAlert,
  TRASH: Trash2,
  OTHER: Folder,
};

function segments(f: MailFolderItem): string[] {
  return f.delimiter ? f.path.split(f.delimiter) : [f.path];
}

export function folderLabel(f: MailFolderItem): string {
  return ROLE_LABELS[f.role] || segments(f).at(-1) || f.path;
}

export function sortFolders(folders: MailFolderItem[]): MailFolderItem[] {
  const system = ROLE_ORDER.flatMap((role) => folders.filter((f) => f.role === role));
  const own = folders.filter((f) => f.role === 'OTHER').sort((a, b) => a.path.localeCompare(b.path, 'ru'));
  return [...system, ...own];
}

export function FolderList({ folders, selectedId, onSelect }: { folders: MailFolderItem[]; selectedId: string | null; onSelect: (id: string) => void }) {
  return (
    <nav className="mail-folders" aria-label="Папки">
      {sortFolders(folders).map((f) => {
        const Icon = ROLE_ICONS[f.role];
        const depth = f.role === 'OTHER' ? segments(f).length - 1 : 0;
        const active = f.id === selectedId;
        return (
          <button
            key={f.id}
            type="button"
            className={`ds-nav-item mail-folder${active ? ' is-active' : ''}`}
            style={{ paddingLeft: 10 + depth * 14 }}
            onClick={() => onSelect(f.id)}
            aria-current={active ? 'true' : undefined}
          >
            <Icon size={16} strokeWidth={1.75} />
            <span className="mail-folder-name">{folderLabel(f)}</span>
            {f.unreadCount > 0 && f.role !== 'SENT' && f.role !== 'DRAFTS' && <span className="ds-nav-count">{f.unreadCount}</span>}
          </button>
        );
      })}
    </nav>
  );
}
