import type { ReactNode } from 'react';
import { File as FileIcon, X, Download } from 'lucide-react';

// Порт FileChip — вложение в сообщении/композере. `icon` — опциональный
// готовый узел (вызывающий код сам решает иконку по MIME-типу, см.
// assistant-message-part.tsx), по умолчанию — обобщённая иконка файла.
interface FileChipProps {
  icon?: ReactNode;
  name: string;
  size?: string;
  onRemove?: () => void;
  onDownload?: () => void;
}

export function FileChip({ icon, name, size, onRemove, onDownload }: FileChipProps) {
  return (
    <span className="ds-attach">
      {icon ?? <FileIcon size={16} strokeWidth={1.75} />}
      <span>{name}</span>
      {size && <small>{size}</small>}
      {onRemove && (
        <button type="button" className="ds-chip-x" aria-label="Убрать файл" onClick={onRemove}>
          <X size={14} strokeWidth={1.75} />
        </button>
      )}
      {onDownload && (
        <button type="button" className="ds-chip-x" aria-label="Скачать" onClick={onDownload}>
          <Download size={14} strokeWidth={1.75} />
        </button>
      )}
    </span>
  );
}
