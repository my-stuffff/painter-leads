import { createContext, useContext } from 'react';
import { Navigate, useLocation } from 'react-router';
import type { Me } from '../shared/api';
import { useMe } from './queries';
import { AppLayout, ShellSkeleton } from './layout/AppLayout';
import { ErrorState } from './components/Page';

const MeCtx = createContext<Me | null>(null);

export function useCurrentUser(): Me {
  const me = useContext(MeCtx);
  if (!me) throw new Error('useCurrentUser outside the signed-in area');
  return me;
}

/** Operators and admins start, cancel and retry searches; viewers only look. */
export const canRun = (me: Me) => me.role === 'admin' || me.role === 'operator';
export const isAdmin = (me: Me) => me.role === 'admin';

export const ROLE_LABEL: Record<Me['role'], string> = { admin: 'Admin', operator: 'Operator', viewer: 'Viewer' };

export function RequireAuth() {
  const me = useMe();
  const loc = useLocation();
  if (me.isPending) return <ShellSkeleton />;
  if (me.isError) {
    if (me.error.status === 401)
      return <Navigate to={`/sign-in?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
    return (
      <div className="mx-auto max-w-md px-4 py-24">
        <ErrorState message={me.error.message} onRetry={() => void me.refetch()} />
      </div>
    );
  }
  return (
    <MeCtx.Provider value={me.data}>
      <AppLayout />
    </MeCtx.Provider>
  );
}
