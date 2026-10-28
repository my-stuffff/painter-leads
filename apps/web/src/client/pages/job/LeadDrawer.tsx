import { clsx } from 'clsx';
import { ExternalLink, Globe, Mail, MapPinned, Phone } from 'lucide-react';
import type { ReactNode } from 'react';
import type { LeadRow } from '../../../shared/api';
import { LEAD_LIST_LABEL } from '../../../shared/api';
import { Drawer } from '../../components/Dialog';
import { Swatch } from '../../components/JobBits';
import { buttonClass, Skeleton, Stars } from '../../components/ui';
import { capitalize, domainOf, fullDate, shortDate } from '../../lib/format';
import { useSources } from '../../queries';

const NOT_FOUND = <span className="text-ink-3">Not found</span>;

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[120px_minmax(0,1fr)] gap-3 py-2 text-sm sm:grid-cols-[140px_minmax(0,1fr)]">
      <dt className="text-ink-2">{label}</dt>
      <dd className="min-w-0 text-ink [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-6">
      <h3 className="mb-1 text-[15px] font-medium text-ink">{title}</h3>
      <dl className="divide-y divide-line border-y border-line">{children}</dl>
    </section>
  );
}

function Confidence({ value }: { value: string | null }) {
  if (!value) return null;
  const v = value.toLowerCase();
  return (
    <span
      className={clsx(
        'inline-flex h-5 items-center rounded-full px-2 text-[12px] font-medium',
        v === 'high' ? 'bg-ok-bg text-ok-ink' : v === 'medium' ? 'bg-warn-bg text-warn-ink' : 'bg-raised text-ink-2',
      )}
    >
      {capitalize(v)}
    </span>
  );
}

function ext(href: string, children: ReactNode, className?: string) {
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" className={clsx('text-accent-ink hover:underline', className)}>
      {children}
    </a>
  );
}

export function LeadDrawer({ lead, open, onClose }: { lead: LeadRow | null; open: boolean; onClose: () => void }) {
  const sources = useSources(open && lead ? lead.companyId : null);
  return (
    <Drawer
      open={open}
      onClose={onClose}
      label={lead ? lead.company : 'Lead'}
      title={lead?.company ?? 'Lead not found'}
      subtitle={
        lead && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-ink-2">
            <span className="inline-flex items-center gap-1.5">
              <Swatch list={lead.list} />
              {LEAD_LIST_LABEL[lead.list]}
            </span>
            <span className="inline-flex items-center gap-1">
              <Stars rating={lead.rating} />
              <span className="text-ink-3">({lead.reviews ?? '—'} reviews)</span>
            </span>
            {lead.category && <span>{lead.category}</span>}
          </div>
        )
      }
    >
      {!lead ? (
        <p className="text-sm text-ink-2">This lead isn’t in the current lists.</p>
      ) : (
        <>
          <div className="mb-6 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {lead.phone ? (
              <a href={`tel:${lead.phone.replace(/[^\d+]/g, '')}`} className={buttonClass('secondary', 'md', 'w-full')}>
                <Phone className="size-4" aria-hidden />
                Call
              </a>
            ) : null}
            {lead.email ? (
              <a href={`mailto:${lead.email}`} className={buttonClass('secondary', 'md', 'w-full')}>
                <Mail className="size-4" aria-hidden />
                Email
              </a>
            ) : null}
            {lead.website ? (
              <a href={lead.website} target="_blank" rel="noreferrer noopener" className={buttonClass('secondary', 'md', 'w-full')}>
                <Globe className="size-4" aria-hidden />
                Website
              </a>
            ) : null}
            {lead.googleUrl ? (
              <a href={lead.googleUrl} target="_blank" rel="noreferrer noopener" className={buttonClass('secondary', 'md', 'w-full')}>
                <MapPinned className="size-4" aria-hidden />
                Google
              </a>
            ) : null}
          </div>

          {lead.whyNot && (
            <p className="mb-6 rounded-lg bg-warn-bg px-3.5 py-2.5 text-sm text-warn-ink">
              Not in the main list: {lead.whyNot.charAt(0).toLowerCase() + lead.whyNot.slice(1)}.
            </p>
          )}

          <Group title="Owner">
            <Row label="Name">{lead.owner ?? NOT_FOUND}</Row>
            {lead.owner && <Row label="Title">{lead.ownerTitle ?? NOT_FOUND}</Row>}
            {lead.owner && (
              <Row label="Found in">
                <span className="inline-flex flex-wrap items-center gap-2">
                  {lead.ownerSource ?? NOT_FOUND}
                  <Confidence value={lead.ownerConfidence} />
                </span>
              </Row>
            )}
          </Group>

          <Group title="Contact">
            <Row label="Phone">{lead.phone ?? NOT_FOUND}</Row>
            <Row label="Email">
              {lead.email ? (
                <>
                  <a href={`mailto:${lead.email}`} className="text-accent-ink hover:underline">
                    {lead.email}
                  </a>
                  {lead.emailSource && <span className="block text-[13px] text-ink-3">{lead.emailSource}</span>}
                </>
              ) : (
                NOT_FOUND
              )}
            </Row>
            <Row label="Website">{lead.website ? ext(lead.website, domainOf(lead.website)) : NOT_FOUND}</Row>
          </Group>

          <Group title="Google">
            <Row label="Rating">{lead.rating != null ? lead.rating.toFixed(1) : NOT_FOUND}</Row>
            <Row label="Reviews">{lead.reviews ?? NOT_FOUND}</Row>
            <Row label="Category">{lead.category ?? NOT_FOUND}</Row>
            <Row label="Listing">
              {lead.googleUrl ? (
                ext(
                  lead.googleUrl,
                  <span className="inline-flex items-center gap-1">
                    Open in Google Maps <ExternalLink className="size-3.5" aria-hidden />
                  </span>,
                )
              ) : (
                NOT_FOUND
              )}
            </Row>
          </Group>

          <Group title="Location">
            <Row label="Address">
              {lead.address ? (
                <>
                  {lead.address}
                  <br />
                  {[lead.city, lead.state].filter(Boolean).join(', ')} {lead.zip}
                </>
              ) : (
                NOT_FOUND
              )}
            </Row>
            <Row label="Found searching">{lead.searchCity}</Row>
          </Group>

          <Group title="Checks">
            <Row label="Works on houses">{lead.residentialStatus ?? NOT_FOUND}</Row>
            <Row label="Licence">{lead.licence ?? NOT_FOUND}</Row>
            <Row label="First seen">{lead.firstSeen ? shortDate(lead.firstSeen) : NOT_FOUND}</Row>
            <Row label="Last checked">{lead.lastChecked ? fullDate(lead.lastChecked) : NOT_FOUND}</Row>
          </Group>

          <section>
            <h3 className="mb-2 text-[15px] font-medium text-ink">Sources</h3>
            {sources.isPending ? (
              <div className="flex flex-col gap-2">
                {[0, 1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-12 rounded-lg" />
                ))}
              </div>
            ) : sources.isError ? (
              <p className="text-sm text-bad-ink">{sources.error.message}</p>
            ) : sources.data.length === 0 ? (
              <p className="text-sm text-ink-3">No sources recorded.</p>
            ) : (
              <ul className="divide-y divide-line rounded-xl border border-line">
                {sources.data.map((s, i) => (
                  <li key={`${s.field}-${i}`} className="px-3.5 py-2.5 text-sm">
                    <div className="flex items-start justify-between gap-3">
                      <span className="text-ink-2">{s.field}</span>
                      <Confidence value={s.confidence} />
                    </div>
                    <p className="mt-0.5 font-medium text-ink [overflow-wrap:anywhere]">{s.value}</p>
                    <p className="mt-0.5 text-[13px] text-ink-3">
                      {s.sourceUrl ? ext(s.sourceUrl, s.sourceLabel) : s.sourceLabel}
                      <span>, read {shortDate(s.capturedAt)}</span>
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </Drawer>
  );
}
