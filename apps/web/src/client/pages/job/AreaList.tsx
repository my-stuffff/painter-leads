import { clsx } from 'clsx';
import type { JobArea } from '../../../shared/api';
import { MiniProgress } from '../../components/RollerProgress';
import { StatusPill } from '../../components/StatusPill';
import { Panel } from '../../components/ui';
import { capitalize, clock, num } from '../../lib/format';

function stepText(a: JobArea): string {
  if (a.status === 'reused') return 'Used earlier data';
  if (a.status === 'queued') return 'Not started';
  if (a.status === 'cancelled') return 'Stopped';
  if (!a.progress) return '—';
  return capitalize(a.progress.stage);
}

function messageOf(a: JobArea): string | null {
  if (a.message) return a.message;
  if (a.status === 'waiting' && a.notBefore) return `Trying again at ${clock(a.notBefore)}`;
  return null;
}

function Ratio({ done, total, active, label }: { done: number; total: number; active: boolean; label: string }) {
  return (
    <div className="min-w-[96px]">
      <div className="text-[13px] text-ink tabular-nums">
        {num(done)}
        <span className="text-ink-3"> / {num(total)}</span>
      </div>
      <MiniProgress value={total ? done / total : 0} active={active} className="mt-1.5" label={label} tone={active ? 'brand' : done && done === total ? 'ok' : 'muted'} />
    </div>
  );
}

function Msg({ a }: { a: JobArea }) {
  const m = messageOf(a);
  if (!m) return null;
  return (
    <p
      className={clsx(
        'mt-0.5 text-[13px] leading-snug',
        a.status === 'waiting' ? 'text-warn-ink' : a.status === 'failed' ? 'text-bad-ink' : 'text-ink-3',
      )}
    >
      {m}
    </p>
  );
}

export function AreaList({ areas }: { areas: JobArea[] }) {
  return (
    <>
      {/* phone: cards */}
      <ul className="flex flex-col gap-2.5 md:hidden">
        {areas.map((a) => {
          const p = a.progress;
          const active = a.status === 'running';
          return (
            <li key={a.id} className="rounded-xl border border-line bg-surface px-4 py-3.5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium text-ink">{a.label}</p>
                  <p className="text-[13px] text-ink-2">{stepText(a)}</p>
                </div>
                <StatusPill status={a.status} size="sm" />
              </div>
              <Msg a={a} />
              {p && (
                <>
                  <div className="mt-3 grid grid-cols-2 gap-4">
                    <div>
                      <p className="mb-1 text-[12px] text-ink-3">Searches</p>
                      <Ratio done={p.searchesDone} total={p.searchesTotal} active={active && p.stage === 'searching'} label={`${a.label} searches`} />
                    </div>
                    <div>
                      <p className="mb-1 text-[12px] text-ink-3">Listings read</p>
                      <Ratio done={p.placesDone} total={p.placesTotal} active={active && p.stage === 'reading listings'} label={`${a.label} listings`} />
                    </div>
                  </div>
                  <p className="mt-3 text-[13px] text-ink-2">
                    <span className="font-medium text-ink tabular-nums">{num(p.companies)}</span> companies,{' '}
                    <span className="font-medium text-ink tabular-nums">{num(p.painters)}</span> painters
                    {a.attempts > 1 && <span className="text-ink-3">, try {a.attempts}</span>}
                  </p>
                </>
              )}
            </li>
          );
        })}
      </ul>

      {/* desktop: table */}
      <Panel className="hidden overflow-x-auto md:block">
        <table className="w-full min-w-[860px] text-sm">
          <thead>
            <tr className="border-b border-line bg-raised text-left text-[13px] text-ink-2">
              <th className="px-5 py-2.5 font-medium">City</th>
              <th className="px-3 py-2.5 font-medium">Status</th>
              <th className="px-3 py-2.5 font-medium">Step</th>
              <th className="px-3 py-2.5 font-medium">Searches</th>
              <th className="px-3 py-2.5 font-medium">Listings read</th>
              <th className="px-3 py-2.5 text-right font-medium">Companies</th>
              <th className="px-3 py-2.5 text-right font-medium">Painters</th>
              <th className="px-5 py-2.5 text-right font-medium">Tries</th>
            </tr>
          </thead>
          <tbody>
            {areas.map((a) => {
              const p = a.progress;
              const active = a.status === 'running';
              return (
                <tr key={a.id} className={clsx('border-b border-line align-top last:border-0', active && 'bg-tint/40')}>
                  <td className="min-w-[220px] px-5 py-3">
                    <p className="font-medium text-ink">{a.label}</p>
                    <Msg a={a} />
                  </td>
                  <td className="px-3 py-3">
                    <StatusPill status={a.status} size="sm" />
                  </td>
                  <td className="px-3 py-3 whitespace-nowrap text-ink-2">{stepText(a)}</td>
                  <td className="px-3 py-3">
                    {p ? (
                      <Ratio done={p.searchesDone} total={p.searchesTotal} active={active && p.stage === 'searching'} label={`${a.label} searches`} />
                    ) : (
                      <span className="text-ink-3">—</span>
                    )}
                  </td>
                  <td className="px-3 py-3">
                    {p ? (
                      <Ratio done={p.placesDone} total={p.placesTotal} active={active && p.stage === 'reading listings'} label={`${a.label} listings`} />
                    ) : (
                      <span className="text-ink-3">—</span>
                    )}
                  </td>
                  <td className="px-3 py-3 text-right text-ink tabular-nums">{p ? num(p.companies) : <span className="text-ink-3">—</span>}</td>
                  <td className="px-3 py-3 text-right text-ink tabular-nums">{p ? num(p.painters) : <span className="text-ink-3">—</span>}</td>
                  <td className={clsx('px-5 py-3 text-right tabular-nums', a.attempts > 1 ? 'text-warn-ink' : 'text-ink-3')}>
                    {a.attempts || '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Panel>
    </>
  );
}
