import { clsx } from 'clsx';
import { CalendarClock, ChevronDown, Download, FileSpreadsheet, FileText, Hourglass, MapPin, RefreshCw, RotateCcw, Square, User } from 'lucide-react';
import { useState } from 'react';
import type { MouseEvent } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import type { JobDetail, LeadList } from '../../shared/api';
import { LEAD_LIST_LABEL } from '../../shared/api';
import { exportUrl, interceptDownload } from '../api';
import { canRun, useCurrentUser } from '../auth';
import { Dialog } from '../components/Dialog';
import { LIST_ORDER, MetaItem, Swatch } from '../components/JobBits';
import { Menu, MenuItem } from '../components/Menu';
import { ErrorState, PageBody, PageHeader, SectionTitle } from '../components/Page';
import { RollerProgress } from '../components/RollerProgress';
import { ExportProblem, StatusPill } from '../components/StatusPill';
import { useToast } from '../components/Toasts';
import { Button, Panel, Skeleton } from '../components/ui';
import { ago, etaText, fullDate, num, pct, plural, statesText } from '../lib/format';
import { useCancelJob, useJob, useLeads, useRebuildExport, useRetryJob } from '../queries';
import { AreaList } from './job/AreaList';
import { LeadDrawer } from './job/LeadDrawer';
import { LeadsBrowser } from './job/Leads';
import { NotFoundPage } from './NotFound';

function onDownload(e: MouseEvent, url: string) {
  if (interceptDownload(url)) e.preventDefault();
}

function Downloads({ job }: { job: JobDetail }) {
  return (
    <Menu
      button={({ open, toggle, id }) => (
        <Button variant="secondary" onClick={toggle} aria-expanded={open} aria-controls={id} icon={<Download className="size-4" />}>
          Download
          <ChevronDown className={clsx('-mr-1 size-4 text-ink-3 transition-transform', open && 'rotate-180')} aria-hidden />
        </Button>
      )}
    >
      {(close) => (
        <>
          <MenuItem
            href={exportUrl.xlsx(job.id)}
            download
            icon={<FileSpreadsheet className="size-4" />}
            onSelect={(e) => {
              onDownload(e, exportUrl.xlsx(job.id));
              close();
            }}
          >
            Workbook, all lists (XLSX)
          </MenuItem>
          <MenuItem
            href={exportUrl.csv(job.id, 'all')}
            download
            icon={<FileText className="size-4" />}
            onSelect={(e) => {
              onDownload(e, exportUrl.csv(job.id, 'all'));
              close();
            }}
          >
            All lists (CSV)
          </MenuItem>
          <div className="my-1 border-t border-line" />
          {LIST_ORDER.map((l: LeadList) => (
            <MenuItem
              key={l}
              href={exportUrl.csv(job.id, l)}
              download
              icon={<Swatch list={l} className="mx-[3px]" />}
              onSelect={(e) => {
                onDownload(e, exportUrl.csv(job.id, l));
                close();
              }}
            >
              {LEAD_LIST_LABEL[l]} (CSV)
            </MenuItem>
          ))}
        </>
      )}
    </Menu>
  );
}

function SettingsLine({ job }: { job: JobDetail }) {
  const s = job.settings;
  const chips = [
    `Rating ${s.minRating.toFixed(1)} and up`,
    `${s.minReviews}–${s.maxReviews} reviews`,
    plural(s.terms.length, 'search term'),
    s.reuseDays > 0 ? `Reuses results under ${s.reuseDays} days old` : 'Searches every city again',
  ];
  return (
    <ul className="flex flex-wrap gap-1.5">
      {chips.map((c, i) => (
        <li
          key={c}
          title={i === 2 ? s.terms.join(', ') : undefined}
          className="rounded-md bg-raised px-2 py-1 text-[12px] text-ink-2 ring-1 ring-inset ring-line"
        >
          {c}
        </li>
      ))}
    </ul>
  );
}

export function JobPage() {
  const { id: idParam } = useParams();
  const id = Number(idParam);
  const me = useCurrentUser();
  const job = useJob(id);
  const ready = job.data?.exportStatus === 'ready';
  const leads = useLeads(id, job.data?.exportBuiltAt ?? null, ready);
  const cancel = useCancelJob();
  const retry = useRetryJob();
  const rebuild = useRebuildExport();
  const toast = useToast();
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();

  // The open lead lives in the URL (?lead=…) as its own history step: Back (or the phone's back gesture) closes it.
  const leadId = Number(params.get('lead')) || null;
  const lead = leadId && leads.data ? (leads.data.find((r) => r.companyId === leadId) ?? null) : null;
  const openLead = (companyId: number) => {
    const n = new URLSearchParams(params);
    n.set('lead', String(companyId));
    navigate({ search: n.toString() }, { state: { leadFromList: true } });
  };
  const closeLead = () => {
    if ((location.state as { leadFromList?: boolean } | null)?.leadFromList) navigate(-1);
    else {
      const n = new URLSearchParams(params);
      n.delete('lead');
      setParams(n, { replace: true });
    }
  };

  if (!Number.isFinite(id) || (job.isError && job.error.status === 404)) return <NotFoundPage title="Search not found" />;

  if (job.isPending)
    return (
      <PageBody wide>
        <Skeleton className="mb-4 h-6 w-16" />
        <Skeleton className="mb-3 h-9 w-80 max-w-full" />
        <Skeleton className="mb-8 h-5 w-96 max-w-full" />
        <Skeleton className="mb-8 h-36 rounded-xl" />
        <Skeleton className="h-72 rounded-xl" />
      </PageBody>
    );

  if (job.isError)
    return (
      <PageBody wide>
        <PageHeader title="Search" back="/searches" />
        <ErrorState message={job.error.message} onRetry={() => void job.refetch()} />
      </PageBody>
    );

  const j = job.data;
  const live = j.status === 'queued' || j.status === 'running';
  const hasRetryable = j.areas.some((a) => a.status === 'failed' || a.status === 'cancelled');
  const hasOk = j.areas.some((a) => a.status === 'done' || a.status === 'reused');
  const running = j.areas.filter((a) => a.status === 'running');
  const waiting = j.areas.filter((a) => a.status === 'waiting');
  const eta = etaText(j.etaMinutes);

  const act = (m: typeof cancel, done: string) =>
    m.mutate(j.id, {
      onSuccess: () => toast(done),
      onError: (e) => toast(e.message, 'bad'),
    });

  const leadsSection = (
      <section aria-labelledby="leads-h">
        <SectionTitle id="leads-h">Leads</SectionTitle>
        {j.exportStatus === 'ready' ? (
          leads.isPending ? (
            <div className="flex flex-col gap-2">
              <Skeleton className="h-11 rounded-lg" />
              <Skeleton className="h-10 w-2/3 rounded-lg" />
              <Skeleton className="h-96 rounded-xl" />
            </div>
          ) : leads.isError ? (
            <ErrorState message={leads.error.message} onRetry={() => void leads.refetch()} />
          ) : (
            <LeadsBrowser rows={leads.data} onOpen={openLead} />
          )
        ) : j.exportStatus === 'building' ? (
          <Panel className="flex items-center gap-4 px-5 py-5">
            <RefreshCw className="size-5 shrink-0 animate-spin text-accent [animation-duration:1.6s]" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="font-medium text-ink">Building the lead lists…</p>
              <Skeleton className="mt-2 h-2 w-1/2" />
            </div>
          </Panel>
        ) : j.exportStatus === 'failed' ? (
          <Panel className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
            <ExportProblem message={j.exportError ?? 'The lead lists could not be built.'} />
            {canRun(me) && hasOk && (
              <Button size="sm" onClick={() => act(rebuild, 'Rebuilding the lead lists')} busy={rebuild.isPending}>
                Rebuild lists
              </Button>
            )}
          </Panel>
        ) : (
          <Panel className="px-5 py-5 text-sm text-ink-2">
            {live ? (
              <div className="flex items-center gap-4">
                <div className="flex shrink-0 -space-x-1" aria-hidden>
                  {LIST_ORDER.map((l) => (
                    <Swatch key={l} list={l} className="size-4 rounded ring-2 ring-surface" />
                  ))}
                </div>
                <p>The three lead lists are built once every city has finished.</p>
              </div>
            ) : hasOk ? (
              <p>The lead lists haven’t been built.</p>
            ) : (
              <p>No city finished, so there are no leads.</p>
            )}
          </Panel>
        )}
        {ready && j.exportBuiltAt && (
          <p className="mt-3 text-[12px] text-ink-3">
            Lists built {ago(j.exportBuiltAt)}
            {leads.data ? `, ${num(leads.data.length)} leads in all` : ''}.
          </p>
        )}
      </section>
  );

  const citiesSection = (
      <section aria-labelledby="cities-h">
        <SectionTitle id="cities-h">Cities</SectionTitle>
        <AreaList areas={j.areas} />
      </section>
  );

  return (
    <PageBody wide>
      <PageHeader
        back="/searches"
        title={j.name}
        pill={<StatusPill status={j.status} />}
        meta={
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5">
            <MetaItem icon={<MapPin className="size-3.5" />}>
              {statesText(j.states)}, {plural(j.cityCount, 'city', 'cities')}
            </MetaItem>
            {j.createdBy && <MetaItem icon={<User className="size-3.5" />}>{j.createdBy}</MetaItem>}
            <MetaItem icon={<CalendarClock className="size-3.5" />}>
              <span title={fullDate(j.createdAt)}>Started {ago(j.createdAt)}</span>
            </MetaItem>
            {live && eta && <MetaItem icon={<Hourglass className="size-3.5" />}>{eta}</MetaItem>}
            {!live && j.finishedAt && (
              <MetaItem icon={<Hourglass className="size-3.5" />}>
                <span title={fullDate(j.finishedAt)}>Finished {ago(j.finishedAt)}</span>
              </MetaItem>
            )}
          </div>
        }
        actions={
          <>
            {ready && <Downloads job={j} />}
            {canRun(me) && hasRetryable && (
              <Button onClick={() => act(retry, 'Failed cities are queued again')} busy={retry.isPending} icon={<RotateCcw className="size-4" />}>
                Retry failed cities
              </Button>
            )}
            {canRun(me) && !live && hasOk && j.exportStatus !== 'building' && (
              <Button onClick={() => act(rebuild, 'Rebuilding the lead lists')} busy={rebuild.isPending} icon={<RefreshCw className="size-4" />}>
                Rebuild lists
              </Button>
            )}
            {canRun(me) && live && (
              <Button variant="quiet-danger" onClick={() => setConfirmCancel(true)} icon={<Square className="size-3.5" />}>
                Cancel search
              </Button>
            )}
          </>
        }
      />

      {/* overall progress */}
      <Panel className="mb-10 px-5 pt-5 pb-4 sm:px-6">
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
          <div className="flex items-baseline gap-3">
            <span className="font-display text-[40px] leading-none font-medium text-ink tabular-nums">{pct(j.progress)}</span>
            <span className="text-sm text-ink-2">
              {j.citiesDone} of {j.cityCount} {j.cityCount === 1 ? 'city' : 'cities'} done
            </span>
          </div>
          <div className="text-right text-sm text-ink-2">
            {running.length > 0 && (
              <span>
                Now: <span className="font-medium text-ink">{running.map((a) => a.label).join(', ')}</span>
              </span>
            )}
            {running.length === 0 && waiting.length > 0 && <span className="text-warn-ink">Waiting for Google</span>}
            {j.status === 'queued' && running.length === 0 && waiting.length === 0 && <span>Waiting for a free worker</span>}
          </div>
        </div>
        <RollerProgress
          value={j.progress}
          active={j.status === 'running'}
          tone={j.status === 'done' ? 'ok' : j.status === 'failed' ? 'bad' : j.status === 'cancelled' ? 'muted' : 'brand'}
          label="Search progress"
          className="mt-4"
        />
        <div className="mt-2 border-t border-line pt-3.5">
          <SettingsLine job={j} />
        </div>
      </Panel>

      {j.error && (
        <div className="-mt-6 mb-10">
          <ErrorState message={j.error} />
        </div>
      )}

      {/* Leads first once they exist; while the search runs, the cities come first. */}
      <div className="flex flex-col gap-12">
        {ready ? (
          <>
            {leadsSection}
            {citiesSection}
          </>
        ) : (
          <>
            {citiesSection}
            {leadsSection}
          </>
        )}
      </div>

      <LeadDrawer lead={lead} open={leadId != null && !!leads.data} onClose={closeLead} />

      <Dialog
        open={confirmCancel}
        onClose={() => setConfirmCancel(false)}
        title="Cancel this search?"
        footer={
          <>
            <Button onClick={() => setConfirmCancel(false)}>Keep running</Button>
            <Button
              variant="danger"
              busy={cancel.isPending}
              onClick={() =>
                cancel.mutate(j.id, {
                  onSuccess: () => {
                    setConfirmCancel(false);
                    toast('Search cancelled');
                  },
                  onError: (e) => toast(e.message, 'bad'),
                })
              }
            >
              Cancel search
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink-2">
          Cities that haven’t started won’t run. {running.length > 0 && 'The city running now finishes first. '}Leads from finished cities are kept.
        </p>
      </Dialog>
    </PageBody>
  );
}
