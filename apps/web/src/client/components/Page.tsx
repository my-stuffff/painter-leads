import { clsx } from 'clsx';
import { ArrowLeft } from 'lucide-react';
import type { ReactNode } from 'react';
import { useBack } from '../lib/nav';

export function BackButton({ fallback, className }: { fallback: string; className?: string }) {
  const back = useBack(fallback);
  return (
    <button
      type="button"
      onClick={back}
      className={clsx(
        'group -ml-2 inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-ink-2 transition-colors hover:bg-surface hover:text-ink',
        className,
      )}
    >
      <ArrowLeft className="size-4 transition-transform duration-150 group-hover:-translate-x-0.5" aria-hidden />
      Back
    </button>
  );
}

export function PageHeader({
  title,
  back,
  actions,
  meta,
  pill,
}: {
  title: ReactNode;
  /** Parent route used when there is no earlier in-app screen. Omit on Home. */
  back?: string;
  actions?: ReactNode;
  meta?: ReactNode;
  pill?: ReactNode;
}) {
  return (
    <header className="mb-6 sm:mb-8">
      {back && <BackButton fallback={back} className="mb-3" />}
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
        <div className="min-w-0 flex-1 basis-80">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <h1 className="min-w-0 text-[26px] leading-tight font-medium text-ink [overflow-wrap:anywhere] sm:text-[30px]">{title}</h1>
            {pill}
          </div>
          {meta && <div className="mt-2.5">{meta}</div>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </header>
  );
}

export function PageBody({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className={clsx('mx-auto w-full px-4 pt-5 pb-28 sm:px-8 sm:pt-8 lg:pb-16', wide ? 'max-w-[1440px]' : 'max-w-[1120px]')}>
      {children}
    </div>
  );
}

export function SectionTitle({ children, aside, id }: { children: ReactNode; aside?: ReactNode; id?: string }) {
  return (
    <div className="mb-3 flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
      <h2 id={id} className="text-[17px] font-medium text-ink">
        {children}
      </h2>
      {aside}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  children,
  action,
  className,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={clsx('flex flex-col items-center px-6 py-12 text-center', className)}>
      {icon && <div className="mb-4 grid size-12 place-items-center rounded-2xl bg-tint text-accent">{icon}</div>}
      <p className="font-display text-base font-medium text-ink">{title}</p>
      {children && <div className="mt-1.5 max-w-sm text-sm text-ink-2">{children}</div>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="rounded-xl border border-bad/25 bg-bad-bg px-5 py-4 text-sm text-bad-ink" role="alert">
      <p>{message}</p>
      {onRetry && (
        <button type="button" onClick={onRetry} className="mt-2 font-medium underline underline-offset-2">
          Try again
        </button>
      )}
    </div>
  );
}
