import { clsx } from 'clsx';
import { Plus, Search, ServerCog } from 'lucide-react';
import { Link } from 'react-router';
import type { LeadCounts, Overview } from '../../shared/api';
import { LEAD_LIST_LABEL } from '../../shared/api';
import { canRun, useCurrentUser } from '../auth';
import { JobRow, LIST_ORDER, LIST_SWATCH, Swatch } from '../components/JobBits';
import { EmptyState, ErrorState, PageBody, PageHeader, SectionTitle } from '../components/Page';
import { buttonClass, Panel, Skeleton } from '../components/ui';
import { ago, num } from '../lib/format';
import { useJobs, useOverview } from '../queries';

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

function LeadsStrip({ leads }: { leads: LeadCounts }) {
  const total = leads.painting + leads.check + leads.likely;
  return (
    <Panel className="overflow-hidden">
      <div className="px-5 pt-5 pb-4 sm:px-6">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2 className="text-[17px] font-medium text-ink">Leads to date</h2>
          <p className="font-display text-[32px] leading-none font-medium text-ink tabular-nums">{num(total)}</p>
        </div>
        <div className="mt-4 flex h-3 overflow-hidden rounded-full bg-raised ring-1 ring-inset ring-line" aria-hidden>
          {total > 0 &&
            LIST_ORDER.map((l) => (
              <div key={l} className={clsx('h-full first:rounded-l-full last:rounded-r-full', LIST_SWATCH[l])} style={{ width: `${(leads[l] / total) * 100}%` }} />
            ))}
        </div>
      </div>
      <dl className="grid grid-cols-3 divide-x divide-line border-t border-line">
        {LIST_ORDER.map((l) => (
          <div key={l} className="px-4 py-3.5 sm:px-6">
            <dt className="flex items-center gap-1.5 text-[13px] text-ink-2">
              <Swatch list={l} />
              <span className="truncate">
                <span className="sm:hidden">{l === 'painting' ? 'Painting' : LEAD_LIST_LABEL[l]}</span>
                <span className="hidden sm:inline">{LEAD_LIST_LABEL[l]}</span>
              </span>
            </dt>
            <dd className="mt-1 font-display text-xl font-medium text-ink tabular-nums sm:text-2xl">{num(leads[l])}</dd>
          </div>
        ))}
      </dl>
    </Panel>
  );
}

function SystemPanel({ ov }: { ov: Overview }) {
  return (
    <Panel className="px-5 py-5">
      <dl className="grid grid-cols-2 gap-4">
        <div>
          <dt className="text-[13px] text-ink-2">Running</dt>
          <dd className="mt-0.5 font-display text-2xl font-medium text-ink tabular-nums">{ov.jobsRunning}</dd>
        </div>
        <div>
          <dt className="text-[13px] text-ink-2">Waiting in line</dt>
          <dd className="mt-0.5 font-display text-2xl font-medium text-ink tabular-nums">{ov.jobsQueued}</dd>
        </div>
      </dl>
      <div className="mt-5 border-t border-line pt-4">
        <h3 className="mb-3 flex items-center gap-2 text-sm font-medium text-ink">
          <ServerCog className="size-4 text-ink-3" aria-hidden />
          Workers
        </h3>
        {ov.workers.length === 0 ? (
          <p className="text-sm text-ink-3">No workers have checked in.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {ov.workers.map((w) => (
              <li key={w.id} className="flex items-start gap-2.5">
                <span
                  className={clsx('mt-1.5 size-2 shrink-0 rounded-full', w.online ? 'animate-pulse-dot bg-ok' : 'bg-line-strong')}
                  aria-label={w.online ? 'Online' : 'Offline'}
                />
                <div className="min-w-0 text-sm">
                  <p className="font-medium text-ink">{w.id}</p>
                  <p className="truncate text-[13px] text-ink-2">
                    {!w.online ? `Last seen ${ago(w.lastSeenAt)}` : w.doing ? w.doing : 'Idle'}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Panel>
  );
}

export function HomePage() {
  const me = useCurrentUser();
  const ov = useOverview();
  const jobs = useJobs();
  const first = me.name.split(/\s+/)[0] ?? me.name;

  const live = jobs.data?.filter((j) => j.status === 'running' || j.status === 'queued') ?? [];
  const recent = jobs.data?.filter((j) => j.status !== 'running' && j.status !== 'queued').slice(0, 5) ?? [];

  return (
    <PageBody>
      <PageHeader
        title={`${greeting()}, ${first}`}
        actions={
          canRun(me) && (
            <Link to="/searches/new" className={buttonClass('primary', 'md')}>
              <Plus className="size-4" aria-hidden />
              New search
            </Link>
          )
        }
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px] xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex min-w-0 flex-col gap-8">
          {ov.isPending ? (
            <Skeleton className="h-[172px] rounded-xl" />
          ) : ov.isError ? (
            <ErrorState message={ov.error.message} onRetry={() => void ov.refetch()} />
          ) : (
            <LeadsStrip leads={ov.data.leads} />
          )}

          <section aria-labelledby="live-h">
            <SectionTitle id="live-h">Running now</SectionTitle>
            {jobs.isPending ? (
              <div className="flex flex-col gap-2.5">
                <Skeleton className="h-[92px] rounded-xl" />
                <Skeleton className="h-[92px] rounded-xl" />
              </div>
            ) : jobs.isError ? (
              <ErrorState message={jobs.error.message} onRetry={() => void jobs.refetch()} />
            ) : live.length === 0 ? (
              <Panel>
                <EmptyState
                  icon={<Search className="size-5" />}
                  title="Nothing running"
                  action={
                    canRun(me) && (
                      <Link to="/searches/new" className={buttonClass('primary', 'md')}>
                        <Plus className="size-4" aria-hidden />
                        New search
                      </Link>
                    )
                  }
                />
              </Panel>
            ) : (
              <div className="flex flex-col gap-2.5">
                {live.map((j) => (
                  <JobRow key={j.id} job={j} />
                ))}
              </div>
            )}
          </section>

          {recent.length > 0 && (
            <section aria-labelledby="recent-h">
              <SectionTitle
                id="recent-h"
                aside={
                  <Link to="/searches" className="text-sm font-medium text-accent hover:underline">
                    All searches
                  </Link>
                }
              >
                Recent searches
              </SectionTitle>
              <div className="flex flex-col gap-2.5">
                {recent.map((j) => (
                  <JobRow key={j.id} job={j} />
                ))}
              </div>
            </section>
          )}
        </div>

        <aside className="flex flex-col gap-6 lg:pt-0">
          {ov.isPending ? <Skeleton className="h-64 rounded-xl" /> : ov.data ? <SystemPanel ov={ov.data} /> : null}
        </aside>
      </div>
    </PageBody>
  );
}
