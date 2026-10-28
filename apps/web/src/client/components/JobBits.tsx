import { clsx } from 'clsx';
import { CalendarClock, MapPin, User } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import type { JobSummary, LeadCounts, LeadList } from '../../shared/api';
import { LEAD_LIST_LABEL } from '../../shared/api';
import { ago, num, pct, plural, statesText } from '../lib/format';
import { MiniProgress } from './RollerProgress';
import { StatusPill } from './StatusPill';

export const LIST_ORDER: LeadList[] = ['painting', 'check', 'likely'];
export const LIST_SWATCH: Record<LeadList, string> = {
  painting: 'bg-list-painting',
  check: 'bg-list-check',
  likely: 'bg-list-likely',
};
export const LIST_SHORT: Record<LeadList, string> = { painting: 'painting', check: 'check first', likely: 'likely fits' };

export function Swatch({ list, className }: { list: LeadList; className?: string }) {
  return <span className={clsx('inline-block size-2.5 shrink-0 rounded-[3px]', LIST_SWATCH[list], className)} aria-hidden />;
}

export function LeadCountsInline({ counts, className }: { counts: LeadCounts; className?: string }) {
  return (
    <span className={clsx('inline-flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-ink-2', className)}>
      {LIST_ORDER.map((l) => (
        <span key={l} className="inline-flex items-center gap-1.5" title={LEAD_LIST_LABEL[l]}>
          <Swatch list={l} />
          <span className="font-semibold text-ink tabular-nums">{num(counts[l])}</span>
          {LIST_SHORT[l]}
        </span>
      ))}
    </span>
  );
}

export function MetaItem({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-[13px] text-ink-2">
      <span className="shrink-0 text-ink-3">{icon}</span>
      <span className="truncate">{children}</span>
    </span>
  );
}

/** A search as a rich row: name, status, live progress or lead counts. */
export function JobRow({ job, className }: { job: JobSummary; className?: string }) {
  const live = job.status === 'running' || job.status === 'queued';
  return (
    <Link
      to={`/searches/${job.id}`}
      className={clsx(
        'group block rounded-xl border border-line bg-surface px-4 py-3.5 transition-[border-color,box-shadow] duration-150 hover:border-line-strong hover:shadow-[0_2px_10px_-4px_rgb(14_34_51/0.16)] sm:px-5',
        className,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate font-display text-[15px] font-medium text-ink group-hover:text-accent-ink">{job.name}</h3>
          <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1">
            <MetaItem icon={<MapPin className="size-3.5" />}>
              {statesText(job.states)}, {plural(job.cityCount, 'city', 'cities')}
            </MetaItem>
            {job.createdBy && <MetaItem icon={<User className="size-3.5" />}>{job.createdBy}</MetaItem>}
            <MetaItem icon={<CalendarClock className="size-3.5" />}>{ago(job.createdAt)}</MetaItem>
          </div>
        </div>
        <StatusPill status={job.status} size="sm" className="mt-0.5" />
      </div>
      {live ? (
        <div className="mt-3 flex items-center gap-3">
          <MiniProgress value={job.progress} active={job.status === 'running'} className="flex-1" label={`${job.name} progress`} />
          <span className="w-10 text-right text-[13px] font-medium text-ink tabular-nums">{pct(job.progress)}</span>
          <span className="hidden text-[13px] text-ink-3 sm:inline">
            {job.citiesDone} of {job.cityCount} cities
          </span>
        </div>
      ) : job.counts ? (
        <LeadCountsInline counts={job.counts} className="mt-2.5" />
      ) : job.exportStatus === 'building' ? (
        <p className="mt-2.5 text-[13px] text-ink-3">Building the lead lists…</p>
      ) : null}
    </Link>
  );
}
