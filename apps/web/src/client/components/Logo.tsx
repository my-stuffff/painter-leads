import { clsx } from 'clsx';
import { Link } from 'react-router';

/** The mark: a paint roller drawn as a "P" — the roller cover is the bowl, the handle is the stem. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 40 40" className={clsx('shrink-0', className)} aria-hidden>
      <rect width="40" height="40" rx="10" fill="#286b9e" />
      <rect x="9" y="8" width="20" height="9" rx="3" fill="#fff" />
      <path d="M12.5 10.3h13" stroke="#286b9e" strokeOpacity=".25" strokeWidth="1.2" strokeLinecap="round" />
      <path d="M29 12.5h2.6V21H14" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="9.5" y="19" width="5.5" height="14" rx="2.2" fill="#fff" />
    </svg>
  );
}

/** Mark + wordmark. Always links home. */
export function Logo({ tone = 'light', compact, className }: { tone?: 'light' | 'dark'; compact?: boolean; className?: string }) {
  return (
    <Link to="/" className={clsx('group inline-flex items-center gap-2.5 rounded-lg', className)} aria-label="Painter Promotions Lead Finder — home">
      <LogoMark className="size-9 transition-transform duration-200 group-hover:-rotate-3" />
      {!compact && (
        <span className="flex flex-col leading-none">
          <span
            className={clsx(
              'font-display text-[15px] font-medium tracking-[-0.01em]',
              tone === 'light' ? 'text-white' : 'text-ink',
            )}
          >
            Painter Promotions
          </span>
          <span className={clsx('mt-1 text-[12px] font-medium', tone === 'light' ? 'text-[#8cc8bd]' : 'text-teal-ink')}>
            Lead Finder
          </span>
        </span>
      )}
    </Link>
  );
}
