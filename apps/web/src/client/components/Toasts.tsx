import { clsx } from 'clsx';
import { CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

type Tone = 'ok' | 'bad' | 'info';
interface Toast {
  id: number;
  title: string;
  tone: Tone;
}

const Ctx = createContext<(title: string, tone?: Tone) => void>(() => {});

export function useToast() {
  return useContext(Ctx);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);

  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const push = useCallback(
    (title: string, tone: Tone = 'ok') => {
      const id = next.current++;
      setToasts((t) => [...t.slice(-3), { id, title, tone }]);
      window.setTimeout(() => dismiss(id), tone === 'bad' ? 7000 : 4000);
    },
    [dismiss],
  );
  const value = useMemo(() => push, [push]);

  return (
    <Ctx.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-4 bottom-4 z-[60] flex flex-col items-center gap-2 sm:inset-x-auto sm:right-5 sm:bottom-5 sm:items-end"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            role={t.tone === 'bad' ? 'alert' : 'status'}
            className="pointer-events-auto flex w-full max-w-sm animate-pop items-start gap-2.5 rounded-xl border border-line bg-surface py-3 pr-2 pl-3.5 text-sm text-ink shadow-[var(--shadow-pop)]"
          >
            {t.tone === 'ok' && <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-ok" aria-hidden />}
            {t.tone === 'bad' && <XCircle className="mt-0.5 size-4 shrink-0 text-bad" aria-hidden />}
            {t.tone === 'info' && <Info className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />}
            <span className="flex-1 leading-5">{t.title}</span>
            <button
              type="button"
              onClick={() => dismiss(t.id)}
              className={clsx('-my-1 rounded-md p-1 text-ink-3 hover:bg-raised hover:text-ink')}
              aria-label="Dismiss"
            >
              <X className="size-4" />
            </button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
