import { useQueryClient } from '@tanstack/react-query';
import { Eye, EyeOff } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { api, HttpError } from '../api';
import { Logo } from '../components/Logo';
import { Button, Field, Input } from '../components/ui';
import { keys } from '../queries';

/** Only same-app paths are allowed as the page to return to. */
function safeNext(next: string | null) {
  return next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/sign-in') ? next : '/';
}

export function SignInPage() {
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Already signed in (e.g. opened /sign-in by hand): go straight on.
  useEffect(() => {
    let live = true;
    api
      .me()
      .then((me) => {
        if (!live) return;
        qc.setQueryData(keys.me, me);
        navigate(next, { replace: true });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [navigate, next, qc]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!email.trim() || !password) {
      setError('Enter your email and password.');
      return;
    }
    setBusy(true);
    try {
      const me = await api.login({ email: email.trim(), password });
      qc.setQueryData(keys.me, me);
      navigate(next, { replace: true });
    } catch (err) {
      setError(err instanceof HttpError && err.status === 401 ? err.message || 'Email or password is wrong.' : (err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="relative grid min-h-dvh place-items-center overflow-hidden bg-navy px-4 py-10">
      <PaintStroke />
      <div className="relative w-full max-w-[400px] animate-pop">
        <div className="mb-7 flex justify-center">
          <Logo />
        </div>
        <form
          onSubmit={submit}
          noValidate
          className="rounded-2xl border border-white/10 bg-surface px-6 pt-7 pb-6 shadow-[0_24px_60px_-20px_rgb(0_0_0/0.55)] sm:px-8"
        >
          <h1 className="mb-6 text-2xl font-medium text-ink">Sign in</h1>
          <div className="flex flex-col gap-4">
            <Field label="Email">
              {(id) => (
                <Input
                  id={id}
                  type="email"
                  autoComplete="username"
                  inputMode="email"
                  autoFocus
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@painterpromotions.com"
                  aria-invalid={!!error}
                />
              )}
            </Field>
            <Field label="Password">
              {(id) => (
                <div className="relative">
                  <Input
                    id={id}
                    type={show ? 'text' : 'password'}
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="pr-11"
                    aria-invalid={!!error}
                  />
                  <button
                    type="button"
                    onClick={() => setShow((s) => !s)}
                    className="absolute inset-y-0 right-0 grid w-10 place-items-center rounded-r-lg text-ink-3 hover:text-ink"
                    aria-label={show ? 'Hide password' : 'Show password'}
                  >
                    {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </button>
                </div>
              )}
            </Field>
            {error && (
              <p role="alert" className="rounded-lg bg-bad-bg px-3 py-2 text-sm text-bad-ink">
                {error}
              </p>
            )}
            <Button type="submit" variant="primary" size="lg" busy={busy} className="mt-1 w-full">
              Sign in
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** A broad roller stroke across the backdrop. */
function PaintStroke() {
  return (
    <svg
      className="pointer-events-none absolute -left-[10%] top-[14%] h-[70%] w-[120%] opacity-90"
      viewBox="0 0 1200 600"
      preserveAspectRatio="none"
      aria-hidden
    >
      <defs>
        <linearGradient id="pp-stroke" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" stopColor="#286b9e" stopOpacity="0" />
          <stop offset="0.25" stopColor="#286b9e" stopOpacity="0.55" />
          <stop offset="0.8" stopColor="#1f5a86" stopOpacity="0.5" />
          <stop offset="1" stopColor="#59afa1" stopOpacity="0.35" />
        </linearGradient>
      </defs>
      <path
        d="M0 250 C 120 236, 260 262, 400 244 S 680 226, 820 246 S 1080 262, 1200 238 L 1200 392 C 1080 410, 960 388, 820 402 S 560 420, 400 398 S 140 384, 0 404 Z"
        fill="url(#pp-stroke)"
      />
      {Array.from({ length: 18 }, (_, i) => (
        <rect key={i} x={0} y={262 + i * 7.5} width={1200} height={1.2} fill="#ffffff" opacity={0.035} />
      ))}
    </svg>
  );
}
