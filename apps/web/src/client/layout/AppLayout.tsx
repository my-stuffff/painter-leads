import { clsx } from 'clsx';
import { ChevronsUpDown, Home, ListChecks, LogOut, Menu as MenuIcon, Monitor, Moon, Plus, Sun, Users, X } from 'lucide-react';
import { Suspense, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { api } from '../api';
import { canRun, isAdmin, ROLE_LABEL, useCurrentUser } from '../auth';
import { Logo, LogoMark } from '../components/Logo';
import { Menu } from '../components/Menu';
import { Skeleton } from '../components/ui';
import { useTheme } from '../lib/theme';
import type { ThemePref } from '../lib/theme';
import { queryClient, useOverview } from '../queries';

interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
  end?: boolean;
}

function useNavItems(): NavItem[] {
  const me = useCurrentUser();
  const items: NavItem[] = [
    { to: '/', label: 'Home', icon: <Home className="size-[18px]" />, end: true },
    { to: '/searches', label: 'Searches', icon: <ListChecks className="size-[18px]" />, end: false },
  ];
  if (isAdmin(me)) items.push({ to: '/users', label: 'Users', icon: <Users className="size-[18px]" /> });
  return items;
}

function useSignOut() {
  const navigate = useNavigate();
  return async () => {
    try {
      await api.logout();
    } catch {
      /* the session is gone either way */
    }
    queryClient.clear();
    navigate('/sign-in', { replace: true });
  };
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('');
}

const THEME_OPTIONS: { value: ThemePref; label: string; icon: ReactNode }[] = [
  { value: 'light', label: 'Light', icon: <Sun className="size-4" /> },
  { value: 'system', label: 'System', icon: <Monitor className="size-4" /> },
  { value: 'dark', label: 'Dark', icon: <Moon className="size-4" /> },
];

function ThemeSwitch({ onDark }: { onDark?: boolean }) {
  const [pref, setPref] = useTheme();
  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className={clsx('grid grid-cols-3 gap-0.5 rounded-lg p-0.5', onDark ? 'bg-white/[0.06]' : 'bg-raised ring-1 ring-line')}
    >
      {THEME_OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={pref === o.value}
          title={o.label}
          onClick={() => setPref(o.value)}
          className={clsx(
            'flex h-7 items-center justify-center gap-1.5 rounded-md text-[12px] font-medium transition-colors',
            onDark
              ? pref === o.value
                ? 'bg-white/[0.14] text-white'
                : 'text-[#9fb4c7] hover:text-white'
              : pref === o.value
                ? 'bg-surface text-ink shadow-sm ring-1 ring-line'
                : 'text-ink-3 hover:text-ink',
          )}
        >
          {o.icon}
          <span className="sr-only">{o.label}</span>
        </button>
      ))}
    </div>
  );
}

function WorkersLine() {
  const ov = useOverview();
  if (!ov.data) return <div className="h-5" />;
  const online = ov.data.workers.filter((w) => w.online).length;
  const busy = ov.data.workers.filter((w) => w.online && w.doing).length;
  return (
    <div className="flex items-center gap-2 px-3 text-[12px] text-[#9fb4c7]">
      <span
        className={clsx('size-2 rounded-full', online ? 'animate-pulse-dot bg-ok' : 'bg-[#5b6f82]')}
        aria-hidden
      />
      {online === 0 ? 'No workers online' : `${online} ${online === 1 ? 'worker' : 'workers'} online${busy ? `, ${busy} busy` : ''}`}
    </div>
  );
}

function UserMenu() {
  const me = useCurrentUser();
  const signOut = useSignOut();
  return (
    <Menu
      side="top"
      align="start"
      className="w-full"
      panelClassName="w-[calc(100%)] min-w-0"
      button={({ open, toggle, id }) => (
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-controls={id}
          className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-white/[0.07]"
        >
          <span className="grid size-8 shrink-0 place-items-center rounded-full bg-[#1d4f77] text-[12px] font-semibold text-white">
            {initials(me.name)}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-medium text-white">{me.name}</span>
            <span className="block truncate text-[12px] text-[#9fb4c7]">{ROLE_LABEL[me.role]}</span>
          </span>
          <ChevronsUpDown className="size-4 text-[#9fb4c7]" aria-hidden />
        </button>
      )}
    >
      {(close) => (
        <div>
          <div className="px-2.5 pt-1.5 pb-2">
            <p className="truncate text-sm font-medium text-ink">{me.name}</p>
            <p className="truncate text-[13px] text-ink-3">{me.email}</p>
          </div>
          <div className="px-1 pb-2">
            <ThemeSwitch />
          </div>
          <div className="border-t border-line pt-1">
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                close();
                void signOut();
              }}
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm text-ink hover:bg-raised"
            >
              <LogOut className="size-4 text-ink-3" aria-hidden />
              Sign out
            </button>
          </div>
        </div>
      )}
    </Menu>
  );
}

function RailLink({ item, onNavigate }: { item: NavItem; onNavigate?: () => void }) {
  return (
    <NavLink
      to={item.to}
      end={item.end}
      onClick={onNavigate}
      className={({ isActive }) =>
        clsx(
          'relative flex h-9 items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors duration-150',
          isActive ? 'bg-white/[0.1] text-white' : 'text-[#b5c6d6] hover:bg-white/[0.05] hover:text-white',
        )
      }
    >
      {({ isActive }) => (
        <>
          {isActive && <span className="absolute top-2 bottom-2 -left-3 w-1 rounded-r-full bg-teal" aria-hidden />}
          <span className={isActive ? 'text-[#8cc8bd]' : ''}>{item.icon}</span>
          {item.label}
        </>
      )}
    </NavLink>
  );
}

function NewSearchLink({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <NavLink
      to="/searches/new"
      onClick={onNavigate}
      className={({ isActive }) =>
        clsx(
          'flex h-10 items-center justify-center gap-2 rounded-lg text-sm font-semibold transition-colors duration-150',
          isActive ? 'bg-white text-navy' : 'bg-brand text-white shadow-[0_1px_0_rgb(255_255_255/0.15)_inset] hover:bg-[#3279ae]',
        )
      }
    >
      <Plus className="size-4" aria-hidden />
      New search
    </NavLink>
  );
}

function Rail() {
  const me = useCurrentUser();
  const items = useNavItems();
  return (
    <aside className="fixed inset-y-0 left-0 z-30 hidden w-[236px] flex-col bg-navy lg:flex">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(120%_60%_at_0%_0%,rgb(40_107_158/0.35),transparent_60%)]" aria-hidden />
      <div className="relative flex h-full flex-col">
        <div className="px-5 pt-5 pb-6">
          <Logo />
        </div>
        {canRun(me) && (
          <div className="px-4 pb-5">
            <NewSearchLink />
          </div>
        )}
        <nav aria-label="Main" className="flex flex-col gap-0.5 px-3">
          {items.map((i) => (
            <RailLink key={i.to} item={i} />
          ))}
        </nav>
        <div className="mt-auto flex flex-col gap-3 px-3 pb-3">
          <WorkersLine />
          <div className="border-t border-white/[0.08] pt-2">
            <UserMenu />
          </div>
        </div>
      </div>
    </aside>
  );
}

function TopBar() {
  const me = useCurrentUser();
  const items = useNavItems();
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  const signOut = useSignOut();
  useEffect(() => setOpen(false), [loc.pathname]);

  return (
    <header className="sticky top-0 z-40 lg:hidden">
      <div className="flex h-14 items-center justify-between bg-navy px-4">
        <Logo />
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-label={open ? 'Close menu' : 'Open menu'}
          className="-mr-2 grid size-10 place-items-center rounded-lg text-white hover:bg-white/10"
        >
          {open ? <X className="size-5" /> : <MenuIcon className="size-5" />}
        </button>
      </div>
      {open && (
        <>
          <div className="fixed inset-0 top-14 bg-[rgb(5_16_26/0.45)] animate-fade-in" onClick={() => setOpen(false)} aria-hidden />
          <div className="absolute inset-x-0 top-14 animate-fade-in border-t border-white/[0.08] bg-navy px-4 pt-3 pb-4 shadow-xl">
            {canRun(me) && (
              <div className="pb-3">
                <NewSearchLink onNavigate={() => setOpen(false)} />
              </div>
            )}
            <nav aria-label="Main" className="flex flex-col gap-0.5">
              {items.map((i) => (
                <RailLink key={i.to} item={i} onNavigate={() => setOpen(false)} />
              ))}
            </nav>
            <div className="mt-3 flex items-center gap-3 border-t border-white/[0.08] pt-3">
              <span className="grid size-8 shrink-0 place-items-center rounded-full bg-[#1d4f77] text-[12px] font-semibold text-white">
                {initials(me.name)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium text-white">{me.name}</span>
                <span className="block truncate text-[12px] text-[#9fb4c7]">{ROLE_LABEL[me.role]}</span>
              </span>
              <div className="w-[120px]">
                <ThemeSwitch onDark />
              </div>
            </div>
            <button
              type="button"
              onClick={() => void signOut()}
              className="mt-3 flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-white/[0.06] text-sm font-medium text-white hover:bg-white/10"
            >
              <LogOut className="size-4" aria-hidden />
              Sign out
            </button>
          </div>
        </>
      )}
    </header>
  );
}

export function PageFallback() {
  return (
    <div className="mx-auto w-full max-w-[1120px] px-4 pt-8 sm:px-8">
      <Skeleton className="mb-4 h-5 w-20" />
      <Skeleton className="mb-8 h-9 w-72" />
      <Skeleton className="mb-4 h-40 w-full rounded-xl" />
      <Skeleton className="h-64 w-full rounded-xl" />
    </div>
  );
}

export function AppLayout() {
  return (
    <div className="min-h-dvh lg:pl-[236px]">
      <Rail />
      <TopBar />
      <main id="main" className="min-w-0">
        <Suspense fallback={<PageFallback />}>
          <Outlet />
        </Suspense>
      </main>
    </div>
  );
}

export function ShellSkeleton() {
  return (
    <div className="min-h-dvh lg:pl-[236px]">
      <aside className="fixed inset-y-0 left-0 hidden w-[236px] flex-col bg-navy p-5 lg:flex">
        <LogoMark className="size-9" />
      </aside>
      <div className="flex h-14 items-center bg-navy px-4 lg:hidden">
        <LogoMark className="size-9" />
      </div>
      <PageFallback />
    </div>
  );
}
