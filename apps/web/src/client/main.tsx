import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import { setUnauthorizedHandler } from './api';
import { ToastProvider } from './components/Toasts';
import { queryClient } from './queries';
import { router } from './router';
import './styles.css';

// Any 401 (session expired, signed out elsewhere) → sign-in, then back to the same page afterwards.
let redirecting = false;
setUnauthorizedHandler(() => {
  const { pathname, search } = window.location;
  if (pathname === '/sign-in' || redirecting) return;
  redirecting = true;
  void router.navigate(`/sign-in?next=${encodeURIComponent(pathname + search)}`, { replace: true }).finally(() => {
    queryClient.removeQueries();
    redirecting = false;
  });
});

async function boot() {
  if (import.meta.env.VITE_MOCK === '1') {
    const mock = await import('./mock/server');
    mock.install();
  }
  const el = document.getElementById('root');
  if (!el) return;
  createRoot(el).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <RouterProvider router={router} />
        </ToastProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
}

void boot();
