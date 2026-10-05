'use client';

import {
  cloneElement,
  isValidElement,
  useId,
  type InputHTMLAttributes,
  type ReactElement,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { CircleAlert, Search } from 'lucide-react';
import { cx } from './button';

// Порт project/components/src/index.jsx Field/Input/Textarea/Select/
// Checkbox/SearchInput. Передавайте Field РОВНО один контрол (Input/
// Textarea/Select) — Field/README.md. Формы до 520px.

interface FieldProps {
  label?: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}

export function Field({ label, hint, error, children }: FieldProps) {
  const fieldId = useId();
  const describedBy = hint || error ? `${fieldId}-d` : undefined;
  const child = isValidElement(children)
    ? cloneElement(children as ReactElement<Record<string, unknown>>, {
        id: fieldId,
        'aria-invalid': error ? 'true' : undefined,
        'aria-describedby': describedBy,
      })
    : children;
  return (
    <div className="ds-field">
      {label && (
        <label className="ds-field-label" htmlFor={fieldId}>
          {label}
        </label>
      )}
      {child}
      {error ? (
        <div className="ds-field-error" id={describedBy}>
          <CircleAlert size={14} strokeWidth={1.75} />
          {error}
        </div>
      ) : hint ? (
        <div className="ds-field-hint" id={describedBy}>
          {hint}
        </div>
      ) : null}
    </div>
  );
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cx('ds-input', props.className)} />;
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cx('ds-input', props.className)} />;
}

interface SelectOption {
  value: string;
  label: string;
}

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  options?: SelectOption[];
}

export function Select({ options = [], className, children, ...rest }: SelectProps) {
  return (
    <select {...rest} className={cx('ds-input', className)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
      {children}
    </select>
  );
}

interface CheckboxProps extends InputHTMLAttributes<HTMLInputElement> {
  label: ReactNode;
}

export function Checkbox({ label, ...rest }: CheckboxProps) {
  return (
    <label className="ds-check">
      <input type="checkbox" {...rest} />
      {label}
    </label>
  );
}

export function SearchInput({ placeholder = 'Поиск', ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className="ds-search">
      <Search size={16} strokeWidth={1.75} />
      <input placeholder={placeholder} {...rest} />
    </div>
  );
}
