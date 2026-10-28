import { clsx } from 'clsx';
import { useEffect, useId, useRef, useState } from 'react';
import type { MouseEvent, ReactNode } from 'react';

/** Button + popover panel. Closes on outside click, Esc, or when an item is chosen. */
export function Menu({
  button,
  children,
  align = 'end',
  side = 'bottom',
  className,
  panelClassName,
}: {
  button: (props: { open: boolean; toggle: () => void; id: string }) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: 'start' | 'end';
  side?: 'top' | 'bottom';
  className?: string;
  panelClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={root} className={clsx('relative', className)}>
      {button({ open, toggle: () => setOpen((o) => !o), id })}
      {open && (
        <div
          id={id}
          role="menu"
          className={clsx(
            'absolute z-40 min-w-56 animate-pop rounded-xl border border-line bg-surface p-1.5 text-ink shadow-[var(--shadow-pop)]',
            align === 'end' ? 'right-0' : 'left-0',
            side === 'bottom' ? 'top-full mt-1.5' : 'bottom-full mb-1.5',
            panelClassName,
          )}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function MenuItem({
  children,
  icon,
  onSelect,
  href,
  download,
  tone,
}: {
  children: ReactNode;
  icon?: ReactNode;
  onSelect?: (e: MouseEvent) => void;
  href?: string;
  download?: boolean;
  tone?: 'bad';
}) {
  const cls = clsx(
    'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors hover:bg-raised',
    tone === 'bad' ? 'text-bad-ink' : 'text-ink',
  );
  if (href)
    return (
      <a role="menuitem" href={href} download={download || undefined} className={cls} onClick={onSelect}>
        {icon && <span className="text-ink-3">{icon}</span>}
        {children}
      </a>
    );
  return (
    <button type="button" role="menuitem" className={cls} onClick={onSelect}>
      {icon && <span className={tone === 'bad' ? '' : 'text-ink-3'}>{icon}</span>}
      {children}
    </button>
  );
}
