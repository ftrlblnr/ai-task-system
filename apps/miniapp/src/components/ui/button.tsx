'use client';

import type { ButtonHTMLAttributes, ComponentType } from 'react';

// Дизайн-система «Адъютант» (владелец 04.10.2026, project/implementation.md
// шаг 4) — порт project/components/src/index.jsx Button/IconButton на
// lucide-react вместо лукап-таблицы Icon из эталона. Стили — .ds-btn* в
// packages/design-tokens/ds.css.

export type IconComponent = ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'agent';
type ButtonSize = 'sm' | 'md' | 'lg';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconComponent;
  iconRight?: IconComponent;
  loading?: boolean;
  block?: boolean;
  kbd?: string;
}

// Не больше одной primary в видимой области экрана — остальные secondary/
// ghost (project/README.md, раздел «Голос и текст» + Button/README.md).
export function Button({
  variant = 'secondary',
  size = 'md',
  icon: Icon,
  iconRight: IconRight,
  loading,
  block,
  kbd,
  className,
  children,
  disabled,
  ...rest
}: ButtonProps) {
  const iconSize = size === 'sm' ? 16 : 18;
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(
        'ds-btn',
        `ds-btn-${variant}`,
        size !== 'md' && `ds-btn-${size}`,
        block && 'ds-btn-block',
        loading && 'ds-btn-loading',
        className,
      )}
    >
      {Icon && <Icon size={iconSize} strokeWidth={1.75} />}
      {children}
      {IconRight && <IconRight size={iconSize} strokeWidth={1.75} />}
      {kbd && <span className="ds-kbd">{kbd}</span>}
      {loading && <span className="ds-spinner" />}
    </button>
  );
}

type IconButtonVariant = 'ghost' | 'outline' | 'primary' | 'agent';
type IconButtonSize = 'sm' | 'md';

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: IconComponent;
  label: string;
  variant?: IconButtonVariant;
  size?: IconButtonSize;
}

// `label` обязателен — становится aria-label и title (IconButton/README.md).
export function IconButton({ icon: Icon, label, variant = 'ghost', size = 'md', className, ...rest }: IconButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      {...rest}
      className={cx('ds-iconbtn', variant !== 'ghost' && `ds-iconbtn-${variant}`, size === 'sm' && 'ds-iconbtn-sm', className)}
    >
      <Icon size={size === 'sm' ? 16 : 18} strokeWidth={1.75} />
    </button>
  );
}

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}
