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
      className={clsx('relative pt-1', active && value < 1 ? 'pb-8' : 'pb-1', className)}
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
          <div className="absolute inset-0 [background-image:repeating-linear-gradient(180deg,rgb(255_255_255/0.09)_0_1px,transparent_1px_4px)]" />
          <div className="absolute inset-y-0 right-0 w-3 bg-[linear-gradient(90deg,transparent,rgb(255_255_255/0.18))]" />
          {active && (
            <div className="absolute inset-y-0 left-0 w-1/3 animate-sheen bg-[linear-gradient(90deg,transparent,rgb(255_255_255/0.35),transparent)]" />
          )}
        </div>
      </div>
      {showRoller && (
        <div
          className="pointer-events-none absolute -top-[2px] transition-[left] duration-700 ease-out"
          style={{ left: `${p}%` }}
          aria-hidden
        >
          <RollerHead />
        </div>
      )}
    </div>
  );
}

function RollerHead() {
  // Side view of a roller moving right: the paint-soaked cover sits on the leading edge, the frame and grip hang below.
  return (
    <svg width="30" height="50" viewBox="0 0 30 50" className="-translate-x-[8px] drop-shadow-[0_2px_3px_rgb(1_57_94/0.35)]">
      <defs>
        <clipPath id="pp-roller-clip">
          <rect x="1" y="1" width="14" height="26" rx="5" />
        </clipPath>
        <linearGradient id="pp-roller-cover" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" stopColor="#3f8cc4" />
          <stop offset="0.55" stopColor="#286b9e" />
          <stop offset="1" stopColor="#1d5683" />
        </linearGradient>
      </defs>
      <path d="M8 27v4.5c0 2.5 1.6 4 4 4h2.5c2.2 0 3.5 1.3 3.5 3.5v1.5" fill="none" stroke="#8a9bad" strokeWidth="2.2" strokeLinecap="round" />
      <rect x="14.6" y="39.5" width="7" height="10" rx="3" fill="#0b2a43" className="dark:fill-[#5ea3d8]" />
      <rect x="1" y="1" width="14" height="26" rx="5" fill="url(#pp-roller-cover)" />
      <g clipPath="url(#pp-roller-clip)">
        <g className="animate-[pp-roll_0.8s_linear_infinite]">
          {Array.from({ length: 12 }, (_, i) => (
            <rect key={i} x="1" y={i * 4 - 20} width="14" height="1.2" fill="#ffffff" opacity="0.16" />
          ))}
        </g>
        <rect x="3.2" y="3" width="2.6" height="22" rx="1.3" fill="#ffffff" opacity="0.38" />
      </g>
      <rect x="1" y="1" width="14" height="26" rx="5" fill="none" stroke="#01395e" strokeWidth="1.1" />
      <style>{'@keyframes pp-roll{from{transform:translateY(0)}to{transform:translateY(4px)}}'}</style>
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
