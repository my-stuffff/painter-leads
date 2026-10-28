import { clsx } from 'clsx';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Phone, Search, X } from 'lucide-react';
import { useCallback, useMemo, useRef } from 'react';
import type { ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import type { LeadList, LeadRow, StateCode } from '../../../shared/api';
import { LEAD_LIST_LABEL } from '../../../shared/api';
import { LIST_ORDER, Swatch } from '../../components/JobBits';
import { EmptyState } from '../../components/Page';
import { Blank, Button, Checkbox, Input, Kbd, Panel, Select, Stars } from '../../components/ui';
import { domainOf, num, STATE_NAME, STATE_ORDER } from '../../lib/format';
import { useHotkey } from '../../lib/nav';

const PAGE = 50;
type SortKey = 'company' | 'owner' | 'phone' | 'email' | 'website' | 'rating' | 'reviews' | 'city';
const COLS: { key: SortKey; label: string; num?: boolean; width: string }[] = [
  { key: 'company', label: 'Company', width: '19%' },
  { key: 'owner', label: 'Owner', width: '12.5%' },
  { key: 'phone', label: 'Phone', width: '12.5%' },
  { key: 'email', label: 'Email', width: '17%' },
  { key: 'website', label: 'Website', width: '13%' },
  { key: 'rating', label: 'Rating', num: true, width: '7%' },
  { key: 'reviews', label: 'Reviews', num: true, width: '7.5%' },
  { key: 'city', label: 'City', width: '11.5%' },
];

function sortValue(r: LeadRow, k: SortKey): string | number | null {
  if (k === 'website') return domainOf(r.website);
  return r[k];
}

/** The three lists with filters, a sortable table (cards on phones) and paging. Filters live in the URL but never add
 *  history entries, so Back always leaves the page in one step. */
export function LeadsBrowser({ rows, onOpen }: { rows: LeadRow[]; onOpen: (companyId: number) => void }) {
  const [params, setParams] = useSearchParams();
  const searchRef = useRef<HTMLInputElement>(null);

  const listParam = params.get('list') as LeadList | null;
  const list: LeadList = listParam && LIST_ORDER.includes(listParam) ? listParam : 'painting';
  const st = (params.get('st') as StateCode | null) ?? '';
  const city = params.get('city') ?? '';
  const noOwner = params.get('noOwner') === '1';
  const noEmail = params.get('noEmail') === '1';
  const q = params.get('q') ?? '';
  const sort = (params.get('sort') as SortKey | null) ?? 'reviews';
  const dir = params.get('dir') === 'asc' ? 'asc' : 'desc';
  const page = Math.max(1, Number(params.get('page')) || 1);

  const set = useCallback(
    (patch: Record<string, string | null>, keepPage = false) => {
      setParams(
        (prev) => {
          const n = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(patch)) {
            if (v == null || v === '') n.delete(k);
            else n.set(k, v);
          }
          if (!keepPage) n.delete('page');
          return n;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  useHotkey(
    '/',
    useCallback((e: KeyboardEvent) => {
      e.preventDefault();
      searchRef.current?.focus();
    }, []),
  );

  const counts = useMemo(() => {
    const c: Record<LeadList, number> = { painting: 0, check: 0, likely: 0 };
    for (const r of rows) c[r.list]++;
    return c;
  }, [rows]);

  const inList = useMemo(() => rows.filter((r) => r.list === list), [rows, list]);
  const statesHere = useMemo(() => STATE_ORDER.filter((s) => rows.some((r) => r.state === s)), [rows]);
  const cityOptions = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of inList) if (!st || r.state === st) m.set(r.searchCity, (m.get(r.searchCity) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [inList, st]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const out = inList.filter(
      (r) =>
        (!st || r.state === st) &&
        (!city || r.searchCity === city) &&
        (!noOwner || !r.owner) &&
        (!noEmail || !r.email) &&
        (!needle ||
          [r.company, r.owner, r.phone, r.email, r.website, r.city, r.searchCity].some((v) => v?.toLowerCase().includes(needle))),
    );
    const mul = dir === 'asc' ? 1 : -1;
    out.sort((a, b) => {
      const va = sortValue(a, sort);
      const vb = sortValue(b, sort);
      if (va == null && vb == null) return a.company.localeCompare(b.company);
      if (va == null) return 1; // blanks last either way
      if (vb == null) return -1;
      const c = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb));
      return c * mul || a.company.localeCompare(b.company);
    });
    return out;
  }, [inList, st, city, noOwner, noEmail, q, sort, dir]);

  const pages = Math.max(1, Math.ceil(filtered.length / PAGE));
  const cur = Math.min(page, pages);
  const shown = filtered.slice((cur - 1) * PAGE, cur * PAGE);
  const anyFilter = !!(st || city || noOwner || noEmail || q);

  const sortBy = (k: SortKey) => {
    if (k === sort) set({ dir: dir === 'asc' ? 'desc' : 'asc' });
    else set({ sort: k, dir: k === 'rating' || k === 'reviews' ? 'desc' : 'asc' });
  };

  return (
    <div>
      {/* tabs */}
      <div role="tablist" aria-label="Lead lists" className="-mx-4 mb-4 flex gap-1 overflow-x-auto border-b border-line px-4 sm:mx-0 sm:px-0">
        {LIST_ORDER.map((l) => {
          const on = l === list;
          return (
            <button
              key={l}
              role="tab"
              type="button"
              aria-selected={on}
              onClick={() => set({ list: l === 'painting' ? null : l, city: null })}
              className={clsx(
                'relative -mb-px flex h-11 shrink-0 items-center gap-2 border-b-2 px-3 text-sm font-medium whitespace-nowrap transition-colors',
                on ? 'border-accent text-ink' : 'border-transparent text-ink-2 hover:text-ink',
              )}
            >
              <Swatch list={l} />
              {LEAD_LIST_LABEL[l]}
              <span className={clsx('rounded-full px-1.5 py-px text-[12px] tabular-nums', on ? 'bg-tint text-accent-ink' : 'bg-raised text-ink-3')}>
                {num(counts[l])}
              </span>
            </button>
          );
        })}
      </div>

      {/* filters */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-72">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-3" aria-hidden />
          <Input
            ref={searchRef}
            value={q}
            onChange={(e) => set({ q: e.target.value })}
            placeholder="Search company, owner, phone…"
            aria-label="Search leads"
            className="pr-10 pl-9"
          />
          <span className="pointer-events-none absolute top-1/2 right-3 hidden -translate-y-1/2 sm:block">
            {q ? null : <Kbd>/</Kbd>}
          </span>
          {q && (
            <button
              type="button"
              onClick={() => set({ q: null })}
              className="absolute top-1/2 right-2 grid size-6 -translate-y-1/2 place-items-center rounded text-ink-3 hover:text-ink"
              aria-label="Clear search"
            >
              <X className="size-4" />
            </button>
          )}
        </div>
        {statesHere.length > 1 && (
          <Select value={st} onChange={(e) => set({ st: e.target.value || null, city: null })} aria-label="State" className="w-auto min-w-[130px] flex-1 sm:flex-none">
            <option value="">All states</option>
            {statesHere.map((s) => (
              <option key={s} value={s}>
                {STATE_NAME[s]}
              </option>
            ))}
          </Select>
        )}
        <Select value={city} onChange={(e) => set({ city: e.target.value || null })} aria-label="City" className="w-auto min-w-[150px] flex-1 sm:flex-none">
          <option value="">All cities</option>
          {cityOptions.map(([c, n]) => (
            <option key={c} value={c}>
              {c} ({n})
            </option>
          ))}
        </Select>
        <div className="flex items-center gap-4 px-1">
          <Checkbox checked={noOwner} onChange={(v) => set({ noOwner: v ? '1' : null })} label="No owner" />
          <Checkbox checked={noEmail} onChange={(v) => set({ noEmail: v ? '1' : null })} label="No email" />
        </div>
        {anyFilter && (
          <button
            type="button"
            onClick={() => set({ st: null, city: null, noOwner: null, noEmail: null, q: null })}
            className="h-9 rounded-lg px-2.5 text-[13px] font-medium text-accent hover:bg-tint"
          >
            Clear filters
          </button>
        )}
        <span className="ml-auto text-[13px] text-ink-3 tabular-nums">
          {filtered.length === inList.length ? plural(filtered.length) : `${num(filtered.length)} of ${num(inList.length)}`}
        </span>
      </div>

      {filtered.length === 0 ? (
        <Panel>
          <EmptyState
            icon={<Search className="size-5" />}
            title={inList.length === 0 ? `No ${LEAD_LIST_LABEL[list].toLowerCase()} in this search` : 'No leads match these filters'}
            action={
              anyFilter && (
                <Button onClick={() => set({ st: null, city: null, noOwner: null, noEmail: null, q: null })}>Clear filters</Button>
              )
            }
          />
        </Panel>
      ) : (
        <>
          {/* phone: cards */}
          <ul className="flex flex-col gap-2 md:hidden">
            {shown.map((r) => (
              <li key={r.companyId}>
                <button
                  type="button"
                  onClick={() => onOpen(r.companyId)}
                  className="block w-full rounded-xl border border-line bg-surface px-4 py-3 text-left transition-colors active:bg-raised"
                >
                  <div className="flex items-start justify-between gap-3">
                    <p className="min-w-0 font-medium text-ink">{r.company}</p>
                    <span className="shrink-0 text-[13px] text-ink-2">
                      <Stars rating={r.rating} /> <span className="text-ink-3">({r.reviews ?? '—'})</span>
                    </span>
                  </div>
                  <p className="mt-0.5 text-[13px] text-ink-2">{r.owner ?? <span className="text-ink-3">No owner found</span>}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-ink-2">
                    {r.phone && (
                      <span className="inline-flex items-center gap-1">
                        <Phone className="size-3.5 text-ink-3" aria-hidden />
                        {r.phone}
                      </span>
                    )}
                    <span className="text-ink-3">{r.searchCity}</span>
                  </div>
                  {r.whyNot && <p className="mt-1.5 text-[12px] text-warn-ink">{r.whyNot}</p>}
                </button>
              </li>
            ))}
          </ul>

          {/* desktop: table */}
          <Panel className="hidden overflow-hidden md:block">
            <div className="scroll-thin max-h-[min(72vh,820px)] overflow-auto">
              <table className="w-full min-w-[1040px] table-fixed text-sm">
                <colgroup>
                  {COLS.map((c) => (
                    <col key={c.key} style={{ width: c.width }} />
                  ))}
                </colgroup>
                <thead className="sticky top-0 z-10">
                  <tr className="bg-raised text-left text-[13px] text-ink-2 shadow-[0_1px_0_var(--line)]">
                    {COLS.map((c) => {
                      const on = c.key === sort;
                      return (
                        <th
                          key={c.key}
                          scope="col"
                          aria-sort={on ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                          className={clsx('px-3 py-0 font-medium first:pl-5 last:pr-5', c.num && 'text-right')}
                        >
                          <button
                            type="button"
                            onClick={() => sortBy(c.key)}
                            className={clsx(
                              'inline-flex h-10 items-center gap-1 whitespace-nowrap hover:text-ink',
                              on && 'text-ink',
                              c.num && 'flex-row-reverse',
                            )}
                          >
                            {c.label}
                            {on ? (
                              dir === 'asc' ? (
                                <ArrowUp className="size-3.5" aria-hidden />
                              ) : (
                                <ArrowDown className="size-3.5" aria-hidden />
                              )
                            ) : (
                              <span className="size-3.5" aria-hidden />
                            )}
                          </button>
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {shown.map((r) => (
                    <tr
                      key={r.companyId}
                      tabIndex={0}
                      onClick={() => onOpen(r.companyId)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') onOpen(r.companyId);
                      }}
                      className="cursor-pointer border-b border-line transition-colors last:border-0 hover:bg-raised focus-visible:bg-tint focus-visible:outline-none"
                    >
                      <td className="py-2.5 pr-3 pl-5">
                        <p className="truncate font-medium text-ink">{r.company}</p>
                        {r.whyNot && <p className="truncate text-[12px] text-warn-ink">{r.whyNot}</p>}
                      </td>
                      <Td>{r.owner ? <span className="block truncate">{r.owner}</span> : <Blank />}</Td>
                      <Td className="truncate whitespace-nowrap">
                        {r.phone ? (
                          <a href={`tel:${r.phone.replace(/[^\d+]/g, '')}`} onClick={(e) => e.stopPropagation()} className="hover:text-accent-ink hover:underline">
                            {r.phone}
                          </a>
                        ) : (
                          <Blank />
                        )}
                      </Td>
                      <Td>
                        {r.email ? (
                          <a href={`mailto:${r.email}`} onClick={(e) => e.stopPropagation()} className="block truncate hover:text-accent-ink hover:underline">
                            {r.email}
                          </a>
                        ) : (
                          <Blank />
                        )}
                      </Td>
                      <Td>
                        {r.website ? (
                          <a
                            href={r.website}
                            target="_blank"
                            rel="noreferrer noopener"
                            onClick={(e) => e.stopPropagation()}
                            className="block truncate text-accent-ink hover:underline"
                          >
                            {domainOf(r.website)}
                          </a>
                        ) : (
                          <Blank />
                        )}
                      </Td>
                      <Td className="text-right whitespace-nowrap">
                        <Stars rating={r.rating} className="justify-end" />
                      </Td>
                      <Td className="text-right tabular-nums">{r.reviews ?? <Blank />}</Td>
                      <td className="py-2.5 pr-5 pl-3 text-ink-2">
                        <span className="block truncate" title={r.searchCity}>
                          {r.searchCity.replace(/, [A-Z]{2}$/, '')}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>

          {pages > 1 && (
            <nav aria-label="Pages" className="mt-3 flex items-center justify-between gap-3">
              <span className="text-[13px] text-ink-3 tabular-nums">
                {num((cur - 1) * PAGE + 1)}–{num(Math.min(cur * PAGE, filtered.length))} of {num(filtered.length)}
              </span>
              <div className="flex items-center gap-1.5">
                <Button size="sm" onClick={() => set({ page: String(cur - 1) }, true)} disabled={cur <= 1} icon={<ChevronLeft className="size-4" />}>
                  Previous
                </Button>
                <span className="px-1.5 text-[13px] text-ink-2 tabular-nums">
                  {cur} / {pages}
                </span>
                <Button size="sm" onClick={() => set({ page: String(cur + 1) }, true)} disabled={cur >= pages} className="flex-row-reverse" icon={<ChevronRight className="size-4" />}>
                  Next
                </Button>
              </div>
            </nav>
          )}
        </>
      )}
    </div>
  );
}

function Td({ children, className }: { children: ReactNode; className?: string }) {
  return <td className={clsx('px-3 py-2.5 text-ink', className)}>{children}</td>;
}

function plural(n: number) {
  return `${num(n)} ${n === 1 ? 'lead' : 'leads'}`;
}
