import { clsx } from 'clsx';
import { Check, History, Minus, Plus, RotateCcw, Search, X } from 'lucide-react';
import { useCallback, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { useNavigate } from 'react-router';
import type { CatalogCity, JobSettings, StateCode } from '../../shared/api';
import { DEFAULT_JOB_SETTINGS } from '../../shared/api';
import { canRun, useCurrentUser } from '../auth';
import { EmptyState, ErrorState, PageBody, PageHeader } from '../components/Page';
import { useToast } from '../components/Toasts';
import { Button, Field, IconButton, Input, Kbd, Panel, Segmented, Skeleton } from '../components/ui';
import { compactPop, daysSince, num, plural, roughDuration, shortDate, STATE_NAME, STATE_ORDER } from '../lib/format';
import { useHotkey } from '../lib/nav';
import { useCatalog, useCreateJob } from '../queries';
import { StateMap } from './new-search/StateMap';

const MIN_PER_ZIP = 1.5;
const REUSE_OPTIONS = [
  { value: 0, label: 'Search again' },
  { value: 7, label: '7 days' },
  { value: 30, label: '30 days' },
  { value: 90, label: '90 days' },
];

function isFresh(c: CatalogCity, reuseDays: number) {
  return !!c.lastRun && reuseDays > 0 && daysSince(c.lastRun.finishedAt) < reuseDays;
}

function Section({ title, aside, children, id }: { title: string; aside?: ReactNode; children: ReactNode; id: string }) {
  return (
    <section aria-labelledby={id} className="scroll-mt-20">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <h2 id={id} className="text-[17px] font-medium text-ink">
          {title}
        </h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

export default function NewSearchPage() {
  const me = useCurrentUser();
  if (!canRun(me))
    return (
      <PageBody>
        <PageHeader title="New search" back="/searches" />
        <Panel>
          <EmptyState icon={<Search className="size-5" />} title="Viewers can’t start searches">
            An operator or admin can start one for you.
          </EmptyState>
        </Panel>
      </PageBody>
    );
  return <NewSearchForm />;
}

function NewSearchForm() {
  const catalog = useCatalog();
  const create = useCreateJob();
  const navigate = useNavigate();
  const toast = useToast();

  const [states, setStates] = useState<Set<StateCode>>(new Set());
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [rating10, setRating10] = useState(Math.round(DEFAULT_JOB_SETTINGS.minRating * 10));
  const [minReviews, setMinReviews] = useState(String(DEFAULT_JOB_SETTINGS.minReviews));
  const [maxReviews, setMaxReviews] = useState(String(DEFAULT_JOB_SETTINGS.maxReviews));
  const [reuseDays, setReuseDays] = useState(DEFAULT_JOB_SETTINGS.reuseDays);
  const [terms, setTerms] = useState<string[]>(DEFAULT_JOB_SETTINGS.terms);
  const [name, setName] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  const cities = useMemo(() => [...(catalog.data?.cities ?? [])].sort((a, b) => b.population - a.population), [catalog.data]);
  const byState = useMemo(() => {
    const m = new Map<StateCode, CatalogCity[]>();
    for (const c of cities) m.set(c.state, [...(m.get(c.state) ?? []), c]);
    return m;
  }, [cities]);
  const maxPop = cities[0]?.population ?? 1;
  const stateCodes = useMemo(() => {
    const listed = catalog.data?.states.map((s) => s.code) ?? STATE_ORDER;
    return STATE_ORDER.filter((s) => listed.includes(s));
  }, [catalog.data]);

  const toggleState = (s: StateCode) => {
    const next = new Set(states);
    if (next.has(s)) {
      next.delete(s);
      setPicked((p) => new Set([...p].filter((id) => !(byState.get(s) ?? []).some((c) => c.areaId === id))));
    } else next.add(s);
    setStates(next);
  };
  const toggleCity = (areaId: string) => {
    const c = cities.find((x) => x.areaId === areaId);
    if (c && !states.has(c.state)) setStates((s) => new Set([...s, c.state]));
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(areaId)) n.delete(areaId);
      else n.add(areaId);
      return n;
    });
  };
  const quickPick = (mode: 'all' | 'top5' | 'top10' | 'none') => {
    const n = new Set<string>();
    if (mode !== 'none')
      for (const s of states) {
        const list = byState.get(s) ?? [];
        for (const c of mode === 'all' ? list : list.slice(0, mode === 'top5' ? 5 : 10)) n.add(c.areaId);
      }
    setPicked(n);
  };

  useHotkey(
    '/',
    useCallback((e: globalThis.KeyboardEvent) => {
      e.preventDefault();
      searchRef.current?.focus();
    }, []),
  );

  // --- the numbers behind the summary -------------------------------------------------------------------------------
  const chosen = cities.filter((c) => picked.has(c.areaId));
  const reused = chosen.filter((c) => isFresh(c, reuseDays));
  const toScrape = chosen.filter((c) => !isFresh(c, reuseDays));
  const zips = chosen.reduce((n, c) => n + c.zipCount, 0);
  const zipsToScrape = toScrape.reduce((n, c) => n + c.zipCount, 0);
  const searches = zipsToScrape * terms.length;
  const minutes = zipsToScrape * MIN_PER_ZIP;
  const minR = Number.parseInt(minReviews, 10);
  const maxR = Number.parseInt(maxReviews, 10);
  const reviewsBad = !Number.isFinite(minR) || !Number.isFinite(maxR) || minR < 0 || maxR < minR;
  const chosenStates = STATE_ORDER.filter((s) => chosen.some((c) => c.state === s));
  const autoName = chosen.length
    ? `${chosenStates.map((s) => STATE_NAME[s]).join(', ')} — ${plural(chosen.length, 'city', 'cities')}`
    : 'Name this search';

  const problem = !chosen.length
    ? 'Pick at least one city.'
    : !terms.length
      ? 'Add at least one search term.'
      : reviewsBad
        ? 'Check the reviews range.'
        : null;

  const start = () => {
    if (problem || create.isPending) return;
    const settings: JobSettings = { minRating: rating10 / 10, minReviews: minR, maxReviews: maxR, reuseDays, terms };
    create.mutate(
      { name: name.trim() || undefined, areaIds: chosen.map((c) => c.areaId), settings },
      {
        onSuccess: (job) => {
          toast('Search started');
          // Replace the form in history: Back from the search goes to where the user came from.
          navigate(`/searches/${job.id}`, { replace: true });
        },
        onError: (e) => toast(e.message, 'bad'),
      },
    );
  };

  const q = query.trim().toLowerCase();
  const visibleStates = stateCodes.filter((s) => states.has(s));

  return (
    <PageBody wide>
      <PageHeader title="New search" back="/searches" />

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_300px] xl:grid-cols-[minmax(0,1fr)_330px]">
        <div className="flex min-w-0 flex-col gap-10">
          {/* States */}
          <Section title="States" id="states-h">
            {catalog.isPending ? (
              <div className="grid gap-3 sm:grid-cols-3">
                {[0, 1, 2].map((i) => (
                  <Skeleton key={i} className="aspect-[7/6] rounded-xl" />
                ))}
              </div>
            ) : catalog.isError ? (
              <ErrorState message={catalog.error.message} onRetry={() => void catalog.refetch()} />
            ) : (
              <div className="grid grid-cols-1 gap-3 min-[480px]:grid-cols-3">
                {stateCodes.map((s) => {
                  const list = byState.get(s) ?? [];
                  const on = states.has(s);
                  const nPicked = list.filter((c) => picked.has(c.areaId)).length;
                  return (
                    <div
                      key={s}
                      role="checkbox"
                      aria-checked={on}
                      tabIndex={0}
                      onClick={() => toggleState(s)}
                      onKeyDown={(e) => {
                        if (e.key === ' ' || e.key === 'Enter') {
                          e.preventDefault();
                          toggleState(s);
                        }
                      }}
                      className={clsx(
                        'group relative grid cursor-pointer grid-cols-[136px_minmax(0,1fr)] overflow-hidden rounded-xl border bg-surface transition-[border-color,box-shadow] duration-150 min-[480px]:grid-cols-1',
                        on
                          ? 'border-accent shadow-[0_0_0_1px_var(--accent),0_6px_20px_-10px_rgb(40_107_158/0.5)]'
                          : 'border-line hover:border-line-strong',
                      )}
                    >
                      <div className="col-start-2 row-start-1 flex items-center justify-between self-end px-4 pt-3.5 min-[480px]:col-start-1 min-[480px]:self-auto">
                        <h3 className="font-display text-base font-medium text-ink">{STATE_NAME[s]}</h3>
                        <span
                          className={clsx(
                            'grid size-5 place-items-center rounded-md border transition-colors',
                            on ? 'border-brand bg-brand text-white' : 'border-line-strong bg-surface text-transparent',
                          )}
                          aria-hidden
                        >
                          <Check className="size-3.5" strokeWidth={3} />
                        </span>
                      </div>
                      <div className="col-start-1 row-span-2 row-start-1 border-r border-line bg-raised/40 p-1 min-[480px]:row-span-1 min-[480px]:row-start-2 min-[480px]:border-0 min-[480px]:bg-transparent min-[480px]:px-1 min-[480px]:py-0">
                        <StateMap code={s} cities={list} picked={picked} active={on} maxPop={maxPop} onToggleCity={toggleCity} />
                      </div>
                      <div className="col-start-2 row-start-2 flex flex-wrap items-center justify-between gap-x-2 self-start px-4 pt-1 pb-3 text-[13px] min-[480px]:col-start-1 min-[480px]:row-start-3 min-[480px]:self-auto min-[480px]:border-t min-[480px]:border-line min-[480px]:py-2.5">
                        <span className="text-ink-2">{plural(list.length, 'city', 'cities')}</span>
                        <span className={clsx('font-medium tabular-nums', nPicked ? 'text-accent-ink' : 'text-ink-3')}>
                          {nPicked ? `${nPicked} picked` : 'None picked'}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Section>

          {/* Cities */}
          <Section
            title="Cities"
            id="cities-h"
            aside={
              states.size > 0 && (
                <div className="flex items-center gap-1" role="group" aria-label="Quick picks">
                  {(
                    [
                      ['all', 'All'],
                      ['top5', 'Top 5'],
                      ['top10', 'Top 10'],
                      ['none', 'None'],
                    ] as const
                  ).map(([k, label]) => (
                    <button
                      key={k}
                      type="button"
                      onClick={() => quickPick(k)}
                      className="h-8 rounded-lg px-2.5 text-[13px] font-medium text-accent transition-colors hover:bg-tint"
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )
            }
          >
            {states.size === 0 ? (
              <Panel>
                <p className="px-5 py-8 text-center text-sm text-ink-2">Pick a state to see its cities.</p>
              </Panel>
            ) : (
              <Panel className="overflow-hidden">
                <div className="border-b border-line p-3">
                  <div className="relative">
                    <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-3" aria-hidden />
                    <Input
                      ref={searchRef}
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="Find a city"
                      aria-label="Find a city"
                      className="pr-10 pl-9"
                    />
                    <span className="pointer-events-none absolute top-1/2 right-3 hidden -translate-y-1/2 sm:block">
                      <Kbd>/</Kbd>
                    </span>
                  </div>
                </div>
                <div className="scroll-thin max-h-[520px] overflow-y-auto">
                  {visibleStates.map((s) => {
                    const list = (byState.get(s) ?? []).filter((c) => !q || c.name.toLowerCase().includes(q));
                    const all = byState.get(s) ?? [];
                    const nPicked = all.filter((c) => picked.has(c.areaId)).length;
                    return (
                      <div key={s}>
                        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-line bg-raised/95 px-4 py-2 backdrop-blur">
                          <span className="text-[13px] font-semibold text-ink">{STATE_NAME[s]}</span>
                          <span className="text-[12px] text-ink-3 tabular-nums">
                            {nPicked} of {all.length} picked
                          </span>
                        </div>
                        {list.length === 0 ? (
                          <p className="px-4 py-3 text-[13px] text-ink-3">No city matches “{query}”.</p>
                        ) : (
                          <ul>
                            {list.map((c) => {
                              const on = picked.has(c.areaId);
                              const fresh = isFresh(c, reuseDays);
                              return (
                                <li key={c.areaId} className="border-b border-line last:border-0">
                                  <label
                                    className={clsx(
                                      'flex cursor-pointer items-center gap-3 px-4 py-2.5 transition-colors',
                                      on ? 'bg-tint/60 hover:bg-tint' : 'hover:bg-raised',
                                    )}
                                  >
                                    <input
                                      type="checkbox"
                                      checked={on}
                                      onChange={() => toggleCity(c.areaId)}
                                      className="size-4 shrink-0 cursor-pointer accent-[var(--accent)]"
                                    />
                                    <span className="min-w-0 flex-1">
                                      <span className="block truncate text-sm font-medium text-ink">{c.name}</span>
                                      <span className="block text-[12px] text-ink-3 sm:hidden">
                                        {compactPop(c.population)} people, {c.zipCount} ZIP codes
                                      </span>
                                    </span>
                                    {fresh && c.lastRun ? (
                                      <span
                                        className="inline-flex shrink-0 items-center gap-1 rounded-full bg-teal-bg px-2 py-0.5 text-[12px] font-medium text-teal-ink"
                                        title="Reused: no new search needed"
                                      >
                                        <History className="size-3" aria-hidden />
                                        <span className="hidden min-[400px]:inline">Data from</span> {shortDate(c.lastRun.finishedAt)}
                                      </span>
                                    ) : null}
                                    <span className="hidden w-16 shrink-0 text-right text-sm text-ink-2 tabular-nums sm:block" title={`${num(c.population)} people (${c.popYear})`}>
                                      {compactPop(c.population)}
                                    </span>
                                    <span className="hidden w-[92px] shrink-0 text-right text-sm text-ink-2 tabular-nums sm:block">
                                      {c.zipCount} ZIPs
                                    </span>
                                  </label>
                                </li>
                              );
                            })}
                          </ul>
                        )}
                      </div>
                    );
                  })}
                </div>
              </Panel>
            )}
          </Section>

          {/* Requirements */}
          <Section title="Requirements" id="req-h">
            <Panel className="grid grid-cols-1 gap-x-8 gap-y-7 px-5 py-5 sm:px-6 md:grid-cols-2">
              <RatingField value={rating10} onChange={setRating10} />

              <div className="flex flex-col gap-1.5">
                <span className="text-[13px] font-medium text-ink-2" id="reviews-l">
                  Number of Google reviews
                </span>
                <div className="flex items-center gap-2" role="group" aria-labelledby="reviews-l">
                  <Input
                    type="number"
                    inputMode="numeric"
                    min={0}
                    value={minReviews}
                    onChange={(e) => setMinReviews(e.target.value)}
                    aria-label="Fewest reviews"
                    placeholder="10"
                    className="w-24 text-center"
                    aria-invalid={reviewsBad}
                  />
                  <span className="text-sm text-ink-3">to</span>
                  <Input
                    type="number"
                    inputMode="numeric"
                    min={0}
                    value={maxReviews}
                    onChange={(e) => setMaxReviews(e.target.value)}
                    aria-label="Most reviews"
                    placeholder="99"
                    className="w-24 text-center"
                    aria-invalid={reviewsBad}
                  />
                </div>
                {reviewsBad && <p className="text-[13px] text-bad-ink">The first number must be 0 or more and not above the second.</p>}
              </div>

              <div className="flex flex-col gap-1.5 md:col-span-2">
                <span className="text-[13px] font-medium text-ink-2">Reuse a city’s earlier results when newer than</span>
                <Segmented label="Reuse earlier results" value={reuseDays} onChange={setReuseDays} options={REUSE_OPTIONS} stretch />
                {reuseDays > 0 && <p className="text-[13px] text-ink-3">Reused cities are instant.</p>}
              </div>

              <TermsField terms={terms} onChange={setTerms} />
            </Panel>
          </Section>

          <Section title="Name" id="name-h">
            <Panel className="px-5 py-5 sm:px-6">
              <Field label="Search name (optional)">
                {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} placeholder={autoName} maxLength={120} />}
              </Field>
            </Panel>
          </Section>
        </div>

        {/* Summary: sticky panel on desktop, bar at the bottom on smaller screens */}
        <aside className="hidden lg:block">
          <div className="sticky top-8">
            <Summary
              cities={chosen.length}
              zips={zips}
              searches={searches}
              reused={reused.length}
              minutes={minutes}
              problem={problem}
              busy={create.isPending}
              onStart={start}
            />
          </div>
        </aside>
      </div>

      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/95 px-4 pt-3 pb-[max(12px,env(safe-area-inset-bottom))] backdrop-blur lg:hidden">
        <div className="mx-auto flex max-w-[1120px] items-center gap-3">
          <div className="min-w-0 flex-1 text-[13px] leading-snug">
            {chosen.length ? (
              <>
                <p className="font-medium text-ink">
                  {plural(chosen.length, 'city', 'cities')}, {num(zips)} ZIP codes
                </p>
                <p className="truncate text-ink-2">
                  {minutes > 0 ? roughDuration(minutes) : 'Instant'}
                  {reused.length ? `, ${reused.length} reused` : ''}
                </p>
              </>
            ) : (
              <p className="text-ink-2">{problem}</p>
            )}
          </div>
          <Button variant="primary" size="lg" onClick={start} disabled={!!problem} busy={create.isPending}>
            Start search
          </Button>
        </div>
      </div>
    </PageBody>
  );
}

function RatingField({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const fill = ((value - 40) / 10) * 100;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor="rating" className="text-[13px] font-medium text-ink-2">
        Lowest Google rating
      </label>
      <div className="flex items-center gap-3">
        <IconButton label="Lower" onClick={() => onChange(Math.max(40, value - 1))} disabled={value <= 40} className="border border-line-strong disabled:opacity-40">
          <Minus className="size-4" />
        </IconButton>
        <span className="inline-flex w-[72px] items-center justify-center gap-1.5 font-display text-2xl font-medium text-ink tabular-nums" aria-live="polite">
          {(value / 10).toFixed(1)}
          <svg viewBox="0 0 20 20" className="size-4 fill-amber" aria-hidden>
            <path d="M10 1.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8L10 14.9l-5.2 2.7 1-5.8L1.6 7.7l5.8-.8z" />
          </svg>
        </span>
        <IconButton label="Higher" onClick={() => onChange(Math.min(50, value + 1))} disabled={value >= 50} className="border border-line-strong disabled:opacity-40">
          <Plus className="size-4" />
        </IconButton>
        <span className="text-sm text-ink-3">and up</span>
      </div>
      <input
        id="rating"
        type="range"
        min={40}
        max={50}
        step={1}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-valuetext={`${(value / 10).toFixed(1)} stars and up`}
        className="range mt-2 w-full max-w-[280px]"
        style={{ ['--fill' as string]: `${fill}%` }}
      />
    </div>
  );
}

function TermsField({ terms, onChange }: { terms: string[]; onChange: (t: string[]) => void }) {
  const [draft, setDraft] = useState('');
  const isDefault = terms.length === DEFAULT_JOB_SETTINGS.terms.length && terms.every((t, i) => t === DEFAULT_JOB_SETTINGS.terms[i]);
  const add = () => {
    const t = draft.trim().replace(/\s+/g, ' ').slice(0, 60);
    if (t && !terms.some((x) => x.toLowerCase() === t.toLowerCase())) onChange([...terms, t]);
    setDraft('');
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      add();
    } else if (e.key === 'Backspace' && !draft && terms.length) onChange(terms.slice(0, -1));
  };
  return (
    <div className="flex flex-col gap-1.5 md:col-span-2">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor="term-input" className="text-[13px] font-medium text-ink-2">
          Google Maps search terms
        </label>
        {!isDefault && (
          <button
            type="button"
            onClick={() => onChange(DEFAULT_JOB_SETTINGS.terms)}
            className="inline-flex items-center gap-1 text-[13px] font-medium text-accent hover:underline"
          >
            <RotateCcw className="size-3.5" aria-hidden />
            Reset
          </button>
        )}
      </div>
      <div className="flex min-h-11 flex-wrap items-center gap-1.5 rounded-lg border border-line-strong bg-surface p-1.5 focus-within:border-accent focus-within:ring-3 focus-within:ring-accent/20">
        {terms.map((t) => (
          <span key={t} className="inline-flex h-7 items-center gap-1 rounded-md bg-tint pr-1 pl-2.5 text-[13px] font-medium text-accent-ink">
            {t}
            <button
              type="button"
              onClick={() => onChange(terms.filter((x) => x !== t))}
              className="grid size-5 place-items-center rounded text-accent-ink/70 hover:bg-accent/15 hover:text-accent-ink"
              aria-label={`Remove ${t}`}
            >
              <X className="size-3.5" />
            </button>
          </span>
        ))}
        <input
          id="term-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKey}
          onBlur={add}
          placeholder={terms.length ? 'Add a term' : 'e.g. house painter'}
          className="h-7 min-w-[120px] flex-1 bg-transparent px-1.5 text-sm text-ink placeholder:text-ink-3 focus:outline-none"
        />
      </div>
      {!terms.length && <p className="text-[13px] text-bad-ink">Add at least one search term.</p>}
    </div>
  );
}

function Summary({
  cities,
  zips,
  searches,
  reused,
  minutes,
  problem,
  busy,
  onStart,
}: {
  cities: number;
  zips: number;
  searches: number;
  reused: number;
  minutes: number;
  problem: string | null;
  busy: boolean;
  onStart: () => void;
}) {
  const rows: [string, string][] = [
    ['ZIP codes', num(zips)],
    ['Google searches', num(searches)],
    ['Reused cities', num(reused)],
  ];
  return (
    <Panel className="overflow-hidden">
      <div className="bg-navy px-5 pt-5 pb-5 text-white">
        <p className="text-[13px] text-[#a9c2d8]">This search covers</p>
        <p className="mt-1 font-display text-[34px] leading-none font-medium tabular-nums">
          {num(cities)} <span className="text-lg font-normal text-[#cfe0ee]">{cities === 1 ? 'city' : 'cities'}</span>
        </p>
        {cities > 0 && (
          <p className="mt-3 text-sm text-[#cfe0ee]">{minutes > 0 ? `Takes ${roughDuration(minutes)}` : 'Instant: every city is reused'}</p>
        )}
      </div>
      <dl className="divide-y divide-line px-5">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-center justify-between py-2.5 text-sm">
            <dt className="text-ink-2">{k}</dt>
            <dd className="font-medium text-ink tabular-nums">{v}</dd>
          </div>
        ))}
      </dl>
      <div className="border-t border-line px-5 pt-4 pb-5">
        <Button variant="primary" size="lg" className="w-full" onClick={onStart} disabled={!!problem} busy={busy}>
          Start search
        </Button>
        {problem && <p className="mt-2.5 text-center text-[13px] text-ink-3">{problem}</p>}
      </div>
    </Panel>
  );
}
