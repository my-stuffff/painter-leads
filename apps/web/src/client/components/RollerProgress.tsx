import { clsx } from 'clsx';

/** The paint-roller progress bar: a stripe of brand-blue paint with the roller at its leading edge. */
export function RollerProgress({
  value,
  active,
  tone = 'brand',
  label,
  className,
}: {
  /** 0..1 */
  value: number;
  /** Running: the roller turns and the paint shines. */
  active?: boolean;
  tone?: 'brand' | 'ok' | 'muted' | 'bad';
  label: string;
  className?: string;
}) {
  const p = Math.max(0, Math.min(1, value)) * 100;
  const showRoller = active && p < 100;
  return (
    <div
      className={clsx('relative pb-3 pt-1', className)}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(p)}
    >
      <div className="relative h-4 overflow-hidden rounded-full bg-raised ring-1 ring-inset ring-line">
        <div
          className={clsx(
            'absolute inset-y-0 left-0 overflow-hidden rounded-r-[5px] transition-[width] duration-700 ease-out',
            tone === 'brand' && 'bg-[linear-gradient(180deg,#3a86bf_0%,#286b9e_55%,#225f8e_100%)]',
            tone === 'ok' && 'bg-[linear-gradient(180deg,#43b45a_0%,#2f9e44_100%)]',
            tone === 'muted' && 'bg-line-strong',
            tone === 'bad' && 'bg-bad/70',
          )}
          style={{ width: `${p}%` }}
        >
          {/* roller nap texture */}
          <div className="absolute inset-0 opacity-25 [background-image:repeating-linear-gradient(90deg,transparent_0_5px,rgb(255_255_255/0.35)_5px_6px)]" />
          {active && (
            <div className="absolute inset-y-0 left-0 w-1/3 animate-sheen bg-[linear-gradient(90deg,transparent,rgb(255_255_255/0.35),transparent)]" />
          )}
        </div>
      </div>
      {showRoller && (
        <div
          className="pointer-events-none absolute top-0 transition-[left] duration-700 ease-out"
          style={{ left: `calc(${p}% - 2px)` }}
          aria-hidden
        >
          <RollerHead />
        </div>
      )}
    </div>
  );
}

function RollerHead() {
  return (
    <svg width="22" height="36" viewBox="0 0 22 36" className="-translate-x-1/2 drop-shadow-[0_2px_2px_rgb(1_57_94/0.35)]">
      <defs>
        <clipPath id="pp-roller-clip">
          <rect x="3" y="0.5" width="12" height="22" rx="4" />
        </clipPath>
      </defs>
      {/* frame + handle */}
      <path d="M9 22.5v3.2c0 1.6 1.2 2.6 2.8 2.6h1.4c1.4 0 2.3.9 2.3 2.2" fill="none" stroke="#0b2a43" strokeWidth="1.6" strokeLinecap="round" className="dark:stroke-[#a5b5c5]" />
      <rect x="13.2" y="29.2" width="4.6" height="6.4" rx="2" fill="#01395e" className="dark:fill-[#5ea3d8]" />
      {/* cover */}
      <rect x="3" y="0.5" width="12" height="22" rx="4" fill="#ffffff" stroke="#01395e" strokeWidth="1.2" />
      <g clipPath="url(#pp-roller-clip)">
        <g className="animate-[roll_0.9s_linear_infinite]">
          {Array.from({ length: 10 }, (_, i) => (
            <rect key={i} x="3" y={i * 5 - 25} width="12" height="2" fill="#286b9e" opacity="0.28" />
          ))}
        </g>
        <rect x="3" y="0.5" width="4" height="22" fill="#ffffff" opacity="0.5" />
      </g>
      <style>{'@keyframes roll{from{transform:translateY(0)}to{transform:translateY(5px)}}'}</style>
    </svg>
  );
}

/** Thin bar for rows and cards. */
export function MiniProgress({
  value,
  active,
  tone = 'brand',
  className,
  label,
}: {
  value: number;
  active?: boolean;
  tone?: 'brand' | 'ok' | 'muted' | 'bad';
  className?: string;
  label: string;
}) {
  const p = Math.max(0, Math.min(1, value)) * 100;
  return (
    <div
      className={clsx('relative h-1.5 overflow-hidden rounded-full bg-raised ring-1 ring-inset ring-line', className)}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(p)}
    >
      <div
        className={clsx(
          'absolute inset-y-0 left-0 overflow-hidden rounded-full transition-[width] duration-700 ease-out',
          tone === 'brand' && 'bg-brand',
          tone === 'ok' && 'bg-ok',
          tone === 'muted' && 'bg-line-strong',
          tone === 'bad' && 'bg-bad/70',
        )}
        style={{ width: `${p}%` }}
      >
        {active && <div className="absolute inset-y-0 left-0 w-1/2 animate-sheen bg-[linear-gradient(90deg,transparent,rgb(255_255_255/0.45),transparent)]" />}
      </div>
    </div>
  );
}
