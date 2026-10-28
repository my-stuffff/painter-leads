import { QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateJobBody, CreateUserBody, JobDetail, Me, UpdateUserBody, UserRow } from '../shared/api';
import { api, HttpError } from './api';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      refetchOnWindowFocus: true,
      retry: (count, err) => {
        const status = err instanceof HttpError ? err.status : 0;
        if (status === 401 || status === 403 || status === 404) return false;
        return count < 2;
      },
    },
  },
});

export const keys = {
  me: ['me'] as const,
  catalog: ['catalog'] as const,
  overview: ['overview'] as const,
  jobs: ['jobs'] as const,
  job: (id: number) => ['job', id] as const,
  leads: (id: number, builtAt: string | null) => ['leads', id, builtAt] as const,
  sources: (companyId: number) => ['sources', companyId] as const,
  users: ['users'] as const,
};

const isLive = (j: { status: string; exportStatus: string } | undefined) =>
  !!j && (j.status === 'queued' || j.status === 'running' || j.exportStatus === 'building');

export function useMe() {
  return useQuery<Me, HttpError>({ queryKey: keys.me, queryFn: api.me, staleTime: 5 * 60_000, retry: false });
}

export function useCatalog() {
  return useQuery({ queryKey: keys.catalog, queryFn: api.catalog, staleTime: 5 * 60_000 });
}

export function useOverview() {
  return useQuery({ queryKey: keys.overview, queryFn: api.overview, refetchInterval: 10_000 });
}

export function useJobs() {
  return useQuery({
    queryKey: keys.jobs,
    queryFn: api.jobs,
    refetchInterval: (q) => (q.state.data?.some(isLive) ? 5_000 : 30_000),
  });
}

export function useJob(id: number) {
  return useQuery<JobDetail, HttpError>({
    queryKey: keys.job(id),
    queryFn: () => api.job(id),
    enabled: Number.isFinite(id),
    refetchInterval: (q) => (isLive(q.state.data) ? 5_000 : false),
  });
}

export function useLeads(id: number, builtAt: string | null, enabled: boolean) {
  return useQuery({
    queryKey: keys.leads(id, builtAt),
    queryFn: () => api.leads(id),
    enabled,
    staleTime: Infinity,
  });
}

export function useSources(companyId: number | null) {
  return useQuery({
    queryKey: keys.sources(companyId ?? -1),
    queryFn: () => api.sources(companyId as number),
    enabled: companyId != null,
    staleTime: 5 * 60_000,
  });
}

export function useUsers(enabled: boolean) {
  return useQuery({ queryKey: keys.users, queryFn: api.users, enabled });
}

function useJobAction(fn: (id: number) => Promise<JobDetail>) {
  const qc = useQueryClient();
  return useMutation<JobDetail, HttpError, number>({
    mutationFn: fn,
    onSuccess: (job) => {
      qc.setQueryData(keys.job(job.id), job);
      void qc.invalidateQueries({ queryKey: keys.jobs });
      void qc.invalidateQueries({ queryKey: keys.overview });
    },
  });
}
export const useCancelJob = () => useJobAction(api.cancelJob);
export const useRetryJob = () => useJobAction(api.retryJob);
export const useRebuildExport = () => useJobAction(api.rebuildExport);

export function useCreateJob() {
  const qc = useQueryClient();
  return useMutation<JobDetail, HttpError, CreateJobBody>({
    mutationFn: api.createJob,
    onSuccess: (job) => {
      qc.setQueryData(keys.job(job.id), job);
      void qc.invalidateQueries({ queryKey: keys.jobs });
      void qc.invalidateQueries({ queryKey: keys.overview });
    },
  });
}

export function useCreateUser() {
  const qc = useQueryClient();
  return useMutation<UserRow, HttpError, CreateUserBody>({
    mutationFn: api.createUser,
    onSuccess: (u) => qc.setQueryData<UserRow[]>(keys.users, (old) => (old ? [...old, u] : [u])),
  });
}

export function useUpdateUser() {
  const qc = useQueryClient();
  return useMutation<UserRow, HttpError, { id: number; body: UpdateUserBody }>({
    mutationFn: ({ id, body }) => api.updateUser(id, body),
    onSuccess: (u) => qc.setQueryData<UserRow[]>(keys.users, (old) => old?.map((x) => (x.id === u.id ? u : x))),
  });
}
