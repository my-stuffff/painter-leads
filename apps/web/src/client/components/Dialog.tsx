import { clsx } from 'clsx';
import { X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { IconButton } from './ui';

function useModal(open: boolean) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      document.documentElement.style.overflow = 'hidden';
    }
    if (!open && d.open) d.close();
    if (!open) document.documentElement.style.overflow = '';
    return () => {
      document.documentElement.style.overflow = '';
    };
  }, [open]);
  return ref;
}

/** Centered modal (native <dialog>: focus stays inside, Esc closes). */
export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  className,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  const ref = useModal(open);
  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      className={clsx(
        'm-auto max-h-[calc(100dvh-32px)] w-[min(460px,calc(100vw-32px))] overflow-visible rounded-2xl border border-line bg-surface p-0 text-ink shadow-[var(--shadow-pop)] open:animate-pop',
        className,
      )}
    >
      {open && (
        <div className="flex max-h-[calc(100dvh-34px)] flex-col">
          <header className="flex items-center justify-between gap-4 px-5 pt-4 pb-2">
            <h2 className="text-lg font-medium text-ink">{title}</h2>
            <IconButton label="Close" onClick={onClose} className="-mr-2">
              <X className="size-[18px]" />
            </IconButton>
          </header>
          <div className="overflow-y-auto px-5 pt-1 pb-5">{children}</div>
          {footer && <footer className="flex justify-end gap-2 border-t border-line bg-raised px-5 py-3 rounded-b-2xl">{footer}</footer>}
        </div>
      )}
    </dialog>
  );
}

/** Side panel from the right; full screen on phones. */
export function Drawer({
  open,
  onClose,
  title,
  subtitle,
  children,
  label,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  label: string;
}) {
  const ref = useModal(open);
  return (
    <dialog
      ref={ref}
      aria-label={label}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      className="fixed inset-y-0 right-0 left-auto m-0 h-dvh max-h-none w-full max-w-none border-0 bg-transparent p-0 text-ink sm:w-[min(600px,92vw)]"
    >
      {open && (
        <div className="flex h-full animate-slide-in flex-col border-l border-line bg-surface shadow-[var(--shadow-pop)]">
          <header className="flex items-start gap-3 border-b border-line px-5 pt-4 pb-4 sm:px-6">
            <div className="min-w-0 flex-1">
              <h2 className="text-xl font-medium leading-tight text-ink">{title}</h2>
              {subtitle && <div className="mt-1.5">{subtitle}</div>}
            </div>
            <IconButton label="Close" onClick={onClose} className="-mt-1 -mr-2">
              <X className="size-5" />
            </IconButton>
          </header>
          <div className="scroll-thin flex-1 overflow-y-auto px-5 py-5 sm:px-6">{children}</div>
        </div>
      )}
    </dialog>
  );
}
