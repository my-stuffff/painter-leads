import { clsx } from 'clsx';
import { KeyRound, Plus, ShieldCheck, Users as UsersIcon, Wand2 } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import type { Role, UserRow } from '../../shared/api';
import { isAdmin, ROLE_LABEL, useCurrentUser } from '../auth';
import { Dialog } from '../components/Dialog';
import { EmptyState, ErrorState, PageBody, PageHeader } from '../components/Page';
import { useToast } from '../components/Toasts';
import { Button, Field, Input, Panel, Select, Skeleton } from '../components/ui';
import { ago, fullDate } from '../lib/format';
import { useCreateUser, useUpdateUser, useUsers } from '../queries';

const ROLES: Role[] = ['admin', 'operator', 'viewer'];

function makePassword() {
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const buf = new Uint32Array(14);
  crypto.getRandomValues(buf);
  return Array.from(buf, (n) => chars[n % chars.length]).join('');
}

function PasswordInput({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex gap-2">
      <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} autoComplete="new-password" spellCheck={false} placeholder="At least 8 characters" />
      <Button onClick={() => onChange(makePassword())} icon={<Wand2 className="size-4" />} className="shrink-0">
        Make one
      </Button>
    </div>
  );
}

function AddUserDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const create = useCreateUser();
  const toast = useToast();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('operator');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setName('');
    setEmail('');
    setRole('operator');
    setPassword('');
    setError(null);
  };
  const close = () => {
    reset();
    onClose();
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !email.trim()) return setError('Enter a name and an email.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return setError('That email doesn’t look right.');
    if (password.length < 8) return setError('The password needs at least 8 characters.');
    create.mutate(
      { name: name.trim(), email: email.trim(), role, password },
      {
        onSuccess: (u) => {
          toast(`${u.name} added. Give them the temporary password.`);
          close();
        },
        onError: (err) => setError(err.message),
      },
    );
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Add user"
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" type="submit" form="add-user" busy={create.isPending}>
            Add user
          </Button>
        </>
      }
    >
      <form id="add-user" onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <Field label="Name">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="e.g. Jordan Reyes" />}</Field>
        <Field label="Email">
          {(id) => <Input id={id} type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@painterpromotions.com" />}
        </Field>
        <Field label="Role" hint={role === 'viewer' ? 'Viewers can look and download, not start searches.' : role === 'admin' ? 'Admins also manage users.' : undefined}>
          {(id) => (
            <Select id={id} value={role} onChange={(e) => setRole(e.target.value as Role)} className="w-full">
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Temporary password">{(id) => <PasswordInput id={id} value={password} onChange={setPassword} />}</Field>
        {error && (
          <p role="alert" className="rounded-lg bg-bad-bg px-3 py-2 text-sm text-bad-ink">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}

function ResetPasswordDialog({ user, onClose }: { user: UserRow | null; onClose: () => void }) {
  const update = useUpdateUser();
  const toast = useToast();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const close = () => {
    setPassword('');
    setError(null);
    onClose();
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!user) return;
    if (password.length < 8) return setError('The password needs at least 8 characters.');
    update.mutate(
      { id: user.id, body: { password } },
      {
        onSuccess: () => {
          toast(`Password reset for ${user.name}`);
          close();
        },
        onError: (err) => setError(err.message),
      },
    );
  };
  return (
    <Dialog
      open={!!user}
      onClose={close}
      title={user ? `Reset password for ${user.name}` : 'Reset password'}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" type="submit" form="reset-pw" busy={update.isPending}>
            Reset password
          </Button>
        </>
      }
    >
      <form id="reset-pw" onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <Field label="New temporary password" hint="They sign in with this one from now on.">
          {(id) => <PasswordInput id={id} value={password} onChange={setPassword} />}
        </Field>
        {error && (
          <p role="alert" className="rounded-lg bg-bad-bg px-3 py-2 text-sm text-bad-ink">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}

function UserRowView({ u, self, onReset }: { u: UserRow; self: boolean; onReset: (u: UserRow) => void }) {
  const update = useUpdateUser();
  const toast = useToast();
  const patch = (body: Parameters<typeof update.mutate>[0]['body'], done: string) =>
    update.mutate({ id: u.id, body }, { onSuccess: () => toast(done), onError: (e) => toast(e.message, 'bad') });

  const roleSelect = (
    <Select
      value={u.role}
      disabled={self || update.isPending}
      onChange={(e) => patch({ role: e.target.value as Role }, `${u.name} is now ${ROLE_LABEL[e.target.value as Role].toLowerCase()}`)}
      aria-label={`Role for ${u.name}`}
      className="h-8 w-[130px] text-[13px]"
      title={self ? 'You can’t change your own role' : undefined}
    >
      {ROLES.map((r) => (
        <option key={r} value={r}>
          {ROLE_LABEL[r]}
        </option>
      ))}
    </Select>
  );
  const status = (
    <span
      className={clsx(
        'inline-flex h-5 items-center rounded-full px-2 text-[12px] font-medium',
        u.disabled ? 'bg-raised text-ink-3 ring-1 ring-inset ring-line-strong' : 'bg-ok-bg text-ok-ink',
      )}
    >
      {u.disabled ? 'Turned off' : 'Active'}
    </span>
  );
  const actions = (
    <div className="flex items-center justify-end gap-1.5">
      <Button size="sm" variant="ghost" onClick={() => onReset(u)} icon={<KeyRound className="size-3.5" />}>
        Reset password
      </Button>
      {!self && (
        <Button
          size="sm"
          variant={u.disabled ? 'secondary' : 'quiet-danger'}
          busy={update.isPending}
          onClick={() => patch({ disabled: !u.disabled }, u.disabled ? `${u.name} can sign in again` : `${u.name} can no longer sign in`)}
        >
          {u.disabled ? 'Turn on' : 'Turn off'}
        </Button>
      )}
    </div>
  );

  return (
    <>
      <tr className={clsx('hidden border-b border-line last:border-0 md:table-row', u.disabled && 'opacity-70')}>
        <td className="px-5 py-3">
          <p className="truncate font-medium text-ink">
            {u.name}
            {self && <span className="ml-2 text-[12px] font-normal text-ink-3">You</span>}
          </p>
          <p className="truncate text-[13px] text-ink-3">{u.email}</p>
        </td>
        <td className="px-3 py-3">{roleSelect}</td>
        <td className="px-3 py-3">{status}</td>
        <td className="px-3 py-3 text-[13px] whitespace-nowrap text-ink-2" title={u.lastLoginAt ? fullDate(u.lastLoginAt) : undefined}>
          {u.lastLoginAt ? ago(u.lastLoginAt) : <span className="text-ink-3">Never</span>}
        </td>
        <td className="px-5 py-3">{actions}</td>
      </tr>
      <tr className="border-b border-line last:border-0 md:hidden">
        <td className="px-4 py-3.5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate font-medium text-ink">
                {u.name}
                {self && <span className="ml-2 text-[12px] font-normal text-ink-3">You</span>}
              </p>
              <p className="truncate text-[13px] text-ink-3">{u.email}</p>
            </div>
            {status}
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            {roleSelect}
            {actions}
          </div>
        </td>
      </tr>
    </>
  );
}

export default function UsersPage() {
  const me = useCurrentUser();
  const admin = isAdmin(me);
  const users = useUsers(admin);
  const [adding, setAdding] = useState(false);
  const [resetting, setResetting] = useState<UserRow | null>(null);

  if (!admin)
    return (
      <PageBody>
        <PageHeader title="Users" back="/" />
        <Panel>
          <EmptyState icon={<ShieldCheck className="size-5" />} title="Only admins can manage users" />
        </Panel>
      </PageBody>
    );

  const rows = [...(users.data ?? [])].sort((a, b) => Number(a.disabled) - Number(b.disabled) || a.name.localeCompare(b.name));

  return (
    <PageBody>
      <PageHeader
        title="Users"
        back="/"
        actions={
          <Button variant="primary" onClick={() => setAdding(true)} icon={<Plus className="size-4" />}>
            Add user
          </Button>
        }
      />
      {users.isPending ? (
        <div className="flex flex-col gap-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-14 rounded-lg" />
          ))}
        </div>
      ) : users.isError ? (
        <ErrorState message={users.error.message} onRetry={() => void users.refetch()} />
      ) : rows.length === 0 ? (
        <Panel>
          <EmptyState icon={<UsersIcon className="size-5" />} title="No users yet" action={<Button onClick={() => setAdding(true)}>Add user</Button>} />
        </Panel>
      ) : (
        <Panel className="overflow-hidden">
          <table className="w-full text-sm md:table-fixed">
            <colgroup className="hidden md:table-column-group">
              <col style={{ width: '31%' }} />
              <col style={{ width: '17%' }} />
              <col style={{ width: '12%' }} />
              <col style={{ width: '13%' }} />
              <col style={{ width: '27%' }} />
            </colgroup>
            <thead className="hidden md:table-header-group">
              <tr className="border-b border-line bg-raised text-left text-[13px] text-ink-2">
                <th className="px-5 py-2.5 font-medium">Name</th>
                <th className="px-3 py-2.5 font-medium">Role</th>
                <th className="px-3 py-2.5 font-medium">Status</th>
                <th className="px-3 py-2.5 font-medium">Last sign-in</th>
                <th className="px-5 py-2.5 text-right font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((u) => (
                <UserRowView key={u.id} u={u} self={u.id === me.id} onReset={setResetting} />
              ))}
            </tbody>
          </table>
        </Panel>
      )}
      <AddUserDialog open={adding} onClose={() => setAdding(false)} />
      <ResetPasswordDialog user={resetting} onClose={() => setResetting(null)} />
    </PageBody>
  );
}
