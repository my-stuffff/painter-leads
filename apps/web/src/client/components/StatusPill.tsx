import { clsx } from 'clsx';
import { Ban, CheckCircle2, CircleDashed, Clock3, History, Loader, TriangleAlert, XCircle } from 'lucide-react';
import type { JobAreaStatus, JobStatus } from '../../shared/api';

type AnyStatus = JobStatus | JobAreaStatus;

const STYLE: Record<AnyStatus, { label: string; cls: string; Icon: typeof Clock3; spin?: boolean }> = {
  queued: { label: 'Queued', cls: 'bg-raised text-ink-2 ring-line-strong', Icon: CircleDashed },
  running: { label: 'Running', cls: 'bg-tint text-accent-ink ring-accent/25', Icon: Loader, spin: true },
  waiting: { label: 'Waiting', cls: 'bg-warn-bg text-warn-ink ring-amber/40', Icon: Clock3 },
  done: { label: 'Done', cls: 'bg-ok-bg text-ok-ink ring-ok/25', Icon: CheckCircle2 },
  reused: { label: 'Used earlier data', cls: 'bg-teal-bg text-teal-ink ring-teal/30', Icon: History },
  failed: { label: 'Failed', cls: 'bg-bad-bg text-bad-ink ring-bad/25', Icon: XCircle },
  cancelled: { label: 'Cancelled', cls: 'bg-raised text-ink-3 ring-line-strong', Icon: Ban },
};

export function StatusPill({ status, className, size = 'md' }: { status: AnyStatus; className?: string; size?: 'sm' | 'md' }) {
  const s = STYLE[status];
  return (
    <span
      className={clsx(
        'inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full font-medium ring-1 ring-inset',
        size === 'sm' ? 'h-5 px-2 text-[12px]' : 'h-6 px-2.5 text-[13px]',
        s.cls,
        className,
      )}
    >
      <s.Icon className={clsx(size === 'sm' ? 'size-3' : 'size-3.5', s.spin && 'animate-[spin_2.4s_linear_infinite]')} aria-hidden />
      {s.label}
    </span>
  );
}

export function ExportProblem({ message }: { message: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[13px] text-bad-ink">
      <TriangleAlert className="size-3.5" aria-hidden />
      {message}
    </span>
  );
}
