import type { StateCode } from '../../shared/api';

export const STATE_NAME: Record<StateCode, string> = { CA: 'California', TX: 'Texas', NJ: 'New Jersey' };
export const STATE_ORDER: StateCode[] = ['CA', 'TX', 'NJ'];

const nf = new Intl.NumberFormat('en-US');
export const num = (n: number) => nf.format(n);

/** 3878704 → "3.88M", 145230 → "145k", 9400 → "9.4k". */
export function compactPop(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 1 : 2).replace(/\.?0+$/, '')}M`;
  if (n >= 100_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(n);
}

export function plural(n: number, one: string, many = `${one}s`) {
  return `${num(n)} ${n === 1 ? one : many}`;
}

/** Minutes → "about 45 min", "about 3 h", "about 2 days". */
export function roughDuration(minutes: number): string {
  if (minutes <= 0) return 'instant';
  if (minutes < 55) return `about ${Math.max(5, Math.round(minutes / 5) * 5)} min`;
  const hours = minutes / 60;
  if (hours < 1.75) {
    const m = Math.round((minutes - 60) / 10) * 10;
    return m > 0 ? `about 1 h ${m} min` : 'about 1 h';
  }
  if (hours < 36) return `about ${Math.round(hours)} h`;
  return `about ${Math.round(hours / 24)} days`;
}

export function etaText(minutes: number | null): string | null {
  if (minutes == null) return null;
  if (minutes <= 1) return 'almost done';
  return `${roughDuration(minutes)} left`;
}

const timeFmt = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
const dayYearFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const fullFmt = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

export const clock = (iso: string) => timeFmt.format(new Date(iso));
export const fullDate = (iso: string) => fullFmt.format(new Date(iso));
export function shortDate(iso: string): string {
  const d = new Date(iso);
  return d.getFullYear() === new Date().getFullYear() ? dayFmt.format(d) : dayYearFmt.format(d);
}

/** "just now", "12 min ago", "3 h ago", "yesterday", "Oct 12". */
export function ago(iso: string | null | undefined): string {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 45) return 'just now';
  const m = s / 60;
  if (m < 60) return `${Math.round(m)} min ago`;
  const h = m / 60;
  if (h < 24) return `${Math.round(h)} h ago`;
  const d = h / 24;
  if (d < 2) return 'yesterday';
  if (d < 7) return `${Math.floor(d)} days ago`;
  return shortDate(iso);
}

export function daysSince(iso: string): number {
  return (Date.now() - new Date(iso).getTime()) / 86_400_000;
}

export function domainOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
  }
}

export function pct(fraction: number): string {
  const p = Math.max(0, Math.min(1, fraction)) * 100;
  if (p > 0 && p < 1) return '<1%';
  if (p < 100 && p > 99) return '99%';
  return `${Math.round(p)}%`;
}

export function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function statesText(states: StateCode[]) {
  return states.map((s) => STATE_NAME[s]).join(', ');
}
