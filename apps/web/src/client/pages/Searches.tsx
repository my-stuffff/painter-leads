import { clsx } from 'clsx';
import { Plus, Search } from 'lucide-react';
import { useMemo } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import type { JobStatus } from '../../shared/api';
import { canRun, useCurrentUser } from '../auth';
import { JobRow, LeadCountsInline } from '../components/JobBits';
import { EmptyState, ErrorState, PageBody, PageHeader } from '../components/Page';
import { MiniProgress } from '../components/RollerProgress';
import { StatusPill } from '../components/StatusPill';
import { buttonClass, Panel, Segmented, Skeleton } from '../components/ui';
import { ago, fullDate, pct, statesText } from '../lib/format';
import { useJobs } from '../queries';

type Filter = 'all' | JobStatus;
const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'running', label: 'Running' },
  { value: 'queued', label: 'Queued' },
  { value: 'done', label: 'Done' },
  { value: 'failed', label: 'Failed' },
  { value: 'cancelled', label: 'Cancelled' },
];

export function SearchesPage() {
  const me = useCurrentUser();
  const jobs = useJobs();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const raw = params.get('status');
  const filter: Filter = FILTERS.some((f) => f.value === raw) ? (raw as Filter) : 'all';

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: jobs.data?.length ?? 0 };
    for (const j of jobs.data ?? []) c[j.status] = (c[j.status] ?? 0) + 1;
    return c;
  }, [jobs.data]);
  const rows = (jobs.data ?? []).filter((j) => filter === 'all' || j.status === filter);

  // Filter changes replace the history entry: Back still leaves the page in one step.
  const setFilter = (f: Filter) => {
    const next = new URLSearchParams(params);
    if (f === 'all') next.delete('status');
    else next.set('status', f);
    setParams(next, { replace: true });
  };

  return (
    <PageBody wide>
      <PageHeader
        title="Searches"
        back="/"
        actions={
          canRun(me) && (
            <Link to="/searches/new" className={buttonClass('primary', 'md')}>
              <Plus className="size-4" aria-hidden />
              New search
            </Link>
          )
        }
      />

      <div className="-mx-4 mb-4 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0">
        <Segmented
          label="Status"
          value={filter}
          onChange={setFilter}
          options={FILTERS.filter((f) => f.value === 'all' || f.value === filter || counts[f.value]).map((f) => ({
            ...f,
            count: counts[f.value] ?? 0,
          }))}
        />
      </div>

      {jobs.isPending ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-14 rounded-lg" />
          ))}
        </div>
      ) : jobs.isError ? (
        <ErrorState message={jobs.error.message} onRetry={() => void jobs.refetch()} />
      ) : rows.length === 0 ? (
        <Panel>
          <EmptyState
            icon={<Search className="size-5" />}
            title={filter === 'all' ? 'No searches yet' : 'No searches with this status'}
            action={
              filter !== 'all' ? (
                <button type="button" onClick={() => setFilter('all')} className={buttonClass('secondary')}>
                  Show all
                </button>
              ) : (
                canRun(me) && (
                  <Link to="/searches/new" className={buttonClass('primary')}>
                    <Plus className="size-4" aria-hidden />
                    New search
                  </Link>
                )
              )
            }
          />
        </Panel>
      ) : (
        <>
          {/* phone: cards */}
          <div className="flex flex-col gap-2.5 md:hidden">
            {rows.map((j) => (
              <JobRow key={j.id} job={j} />
            ))}
          </div>
          {/* desktop: table */}
          <Panel className="hidden overflow-hidden md:block">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line bg-raised text-left text-[13px] text-ink-2">
                  <th className="px-5 py-2.5 font-medium">Search</th>
                  <th className="px-3 py-2.5 font-medium">Status</th>
                  <th className="w-[22%] px-3 py-2.5 font-medium">Progress</th>
                  <th className="px-3 py-2.5 font-medium">Leads</th>
                  <th className="px-5 py-2.5 text-right font-medium">Started</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((j) => {
                  const live = j.status === 'running' || j.status === 'queued';
                  return (
                    <tr
                      key={j.id}
                      onClick={() => navigate(`/searches/${j.id}`)}
                      className="cursor-pointer border-b border-line transition-colors last:border-0 hover:bg-raised"
                    >
                      <td className="max-w-0 px-5 py-3">
                        <Link
                          to={`/searches/${j.id}`}
                          onClick={(e) => e.stopPropagation()}
                          className="block truncate font-medium text-ink hover:text-accent-ink"
                        >
                          {j.name}
                        </Link>
                        <p className="mt-0.5 truncate text-[13px] text-ink-3">
                          {statesText(j.states)}, {j.cityCount} {j.cityCount === 1 ? 'city' : 'cities'}
                          {j.createdBy ? `, by ${j.createdBy}` : ''}
                        </p>
                      </td>
                      <td className="px-3 py-3">
                        <StatusPill status={j.status} size="sm" />
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex items-center gap-2.5">
                          <MiniProgress
                            value={j.progress}
                            active={j.status === 'running'}
                            tone={live ? 'brand' : j.status === 'done' ? 'ok' : 'muted'}
                            className="flex-1"
                            label={`${j.name} progress`}
                          />
                          <span className={clsx('w-16 text-right text-[13px] tabular-nums', live ? 'text-ink' : 'text-ink-3')}>
                            {live ? pct(j.progress) : `${j.citiesDone}/${j.cityCount}`}
                          </span>
                        </div>
                      </td>
                      <td className="px-3 py-3">
                        {j.counts ? (
                          <LeadCountsInline counts={j.counts} className="gap-x-3" />
                        ) : (
                          <span className="text-[13px] text-ink-3">{j.exportStatus === 'building' ? 'Building…' : '—'}</span>
                        )}
                      </td>
                      <td className="px-5 py-3 text-right text-[13px] whitespace-nowrap text-ink-2" title={fullDate(j.createdAt)}>
                        {ago(j.createdAt)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Panel>
        </>
      )}
    </PageBody>
  );
}
