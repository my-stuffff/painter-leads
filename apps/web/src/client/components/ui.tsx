import { clsx } from 'clsx';
import { Loader2 } from 'lucide-react';
import { forwardRef, useId } from 'react';
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'quiet-danger';
type Size = 'sm' | 'md' | 'lg';

export function buttonClass(variant: Variant = 'secondary', size: Size = 'md', extra?: string) {
  return clsx(
    'inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-lg font-medium transition-[background-color,border-color,color,box-shadow,transform] duration-150 active:translate-y-px disabled:pointer-events-none disabled:opacity-50',
    size === 'sm' && 'h-8 px-3 text-[13px]',
    size === 'md' && 'h-9 px-3.5 text-sm',
    size === 'lg' && 'h-11 px-5 text-[15px]',
    variant === 'primary' && 'bg-brand text-white shadow-[0_1px_0_rgb(255_255_255/0.15)_inset,0_1px_2px_rgb(1_57_94/0.35)] hover:bg-brand-hover',
    variant === 'secondary' && 'border border-line-strong bg-surface text-ink hover:border-ink-3/60 hover:bg-raised',
    variant === 'ghost' && 'text-ink-2 hover:bg-raised hover:text-ink',
    variant === 'danger' && 'bg-bad text-white hover:bg-[#c92a2a]',
    variant === 'quiet-danger' && 'border border-line-strong bg-surface text-bad-ink hover:border-bad/50 hover:bg-bad-bg',
    extra,
  );
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  busy?: boolean;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', busy, icon, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  return (
    <button ref={ref} type={type} className={buttonClass(variant, size, className)} disabled={disabled || busy} {...rest}>
      {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
});

export function IconButton({
  label,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={clsx(
        'inline-flex size-9 items-center justify-center rounded-lg text-ink-2 transition-colors duration-150 hover:bg-raised hover:text-ink',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

const fieldBase =
  'h-10 rounded-lg border border-line-strong bg-surface px-3 text-[15px] text-ink placeholder:text-ink-3 transition-[border-color,box-shadow] duration-150 hover:border-ink-3/70 focus:border-accent focus:outline-none focus:ring-3 focus:ring-accent/20 disabled:opacity-60 sm:text-sm';
export const inputClass = `${fieldBase} w-full`;

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...rest },
  ref,
) {
  // A width in className replaces the default full width (two width classes would fight).
  return <input ref={ref} className={clsx(/(^|\s)w-/.test(className ?? '') ? fieldBase : inputClass, className)} {...rest} />;
});

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={clsx(
        fieldBase,
        'cursor-pointer appearance-none bg-[length:16px] bg-[right_10px_center] bg-no-repeat pr-9',
        "bg-[url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%2374859a' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")]",
        className,
      )}
      {...rest}
    >
      {children}
    </select>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  children: (id: string) => ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <div className={clsx('flex flex-col gap-1.5', className)}>
      <label htmlFor={id} className="text-[13px] font-medium text-ink-2">
        {label}
      </label>
      {children(id)}
      {error ? (
        <p className="text-[13px] text-bad-ink" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="text-[13px] text-ink-3">{hint}</p>
      ) : null}
    </div>
  );
}

export function Panel({
  children,
  className,
  as: Tag = 'section',
}: {
  children: ReactNode;
  className?: string;
  as?: 'section' | 'div' | 'article';
}) {
  return <Tag className={clsx('rounded-xl border border-line bg-surface', className)}>{children}</Tag>;
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={clsx('skeleton', className)} aria-hidden />;
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-line-strong bg-raised px-1 font-sans text-[11px] font-medium text-ink-3">
      {children}
    </kbd>
  );
}

export function Segmented<T extends string | number>({
  value,
  onChange,
  options,
  label,
  size = 'md',
  className,
  stretch,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: ReactNode; count?: number }[];
  label: string;
  size?: 'sm' | 'md';
  className?: string;
  /** Fill the width on phones (equal buttons). */
  stretch?: boolean;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={clsx('inline-flex max-w-full rounded-lg bg-raised p-0.5 ring-1 ring-line', stretch && 'flex w-full sm:inline-flex sm:w-auto', className)}
    >
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={String(o.value)}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(o.value)}
            className={clsx(
              'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-[background-color,color,box-shadow] duration-150',
              size === 'sm' ? 'h-7 px-2.5 text-[13px]' : 'h-8 px-3 text-sm',
              stretch && 'flex-1 px-1.5 sm:flex-none sm:px-3',
              on ? 'bg-surface text-ink shadow-[0_1px_2px_rgb(14_34_51/0.12)] ring-1 ring-line' : 'text-ink-2 hover:text-ink',
            )}
          >
            {o.label}
            {o.count != null && (
              <span className={clsx('text-[12px] tabular-nums', on ? 'text-ink-2' : 'text-ink-3')}>{o.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export function Checkbox({
  checked,
  onChange,
  label,
  className,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: ReactNode;
  className?: string;
}) {
  return (
    <label className={clsx('inline-flex cursor-pointer select-none items-center gap-2 text-sm text-ink-2', className)}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="size-4 cursor-pointer rounded accent-[var(--accent)]"
      />
      {label}
    </label>
  );
}

export function Stars({ rating, className }: { rating: number | null; className?: string }) {
  if (rating == null) return <Blank />;
  return (
    <span className={clsx('inline-flex items-center gap-1', className)}>
      <svg viewBox="0 0 20 20" className="size-3.5 shrink-0 fill-amber" aria-hidden>
        <path d="M10 1.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8L10 14.9l-5.2 2.7 1-5.8L1.6 7.7l5.8-.8z" />
      </svg>
      <span className="tabular-nums">{rating.toFixed(1)}</span>
    </span>
  );
}

/** An honest blank: the value was not found. */
export function Blank({ text = '—', title = 'Not found' }: { text?: string; title?: string }) {
  return (
    <span className="text-ink-3" title={title}>
      {text}
    </span>
  );
}
