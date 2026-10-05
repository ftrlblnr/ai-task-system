import type { ReactNode } from 'react';
import { cx } from './button';

// Порт StreamingText — обёртка над уже существующим рендером markdown
// (ReactMarkdown+remarkGfm в assistant-message-part.tsx), не переизобретает
// парсинг: `children` — уже отрендеренный markdown, компонент только
// добавляет класс и курсор-мигание в конце текста на время стрима (CSS
// `.ds-stream.is-streaming > :last-child::after` в ds.css).
export function StreamingText({ streaming, children }: { streaming?: boolean; children: ReactNode }) {
  return (
    <div className={cx('ds-stream', 'ds-md', streaming && 'is-streaming')} aria-busy={streaming || undefined}>
      {children}
    </div>
  );
}
