import type { ReactNode } from 'react';

// Порт UserMessage — пузырь пользователя, справа. Вложения рендерит
// вызывающий код (FileChip) и передаёт готовыми в `attachments`.
interface UserMessageProps {
  children?: ReactNode;
  time?: string;
  attachments?: ReactNode;
}

export function UserMessage({ children, time, attachments }: UserMessageProps) {
  return (
    <div className="ds-msg-user">
      {attachments}
      {children && <div className="ds-bubble">{children}</div>}
      {time && <span className="ds-msg-time">{time}</span>}
    </div>
  );
}
