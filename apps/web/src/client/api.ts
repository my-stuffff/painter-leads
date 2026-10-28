// Browser side of the contract in ../shared/api.ts. Every call goes through `request`, which talks to the server
// (same origin, cookie session, JSON) — or, in mock mode, to the in-memory mock installed by main.tsx.
import type {
  ApiError,
  Catalog,
  CreateJobBody,
  CreateUserBody,
  JobDetail,
  JobSummary,
  LeadList,
  LeadRow,
  LoginBody,
  Me,
  Overview,
  SourceRow,
  UpdateUserBody,
  UserRow,
} from '../shared/api';

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface TransportResponse {
  status: number;
  data: unknown;
}
export type Transport = (method: string, path: string, body?: unknown) => Promise<TransportResponse>;

const httpTransport: Transport = async (method, path, body) => {
  // eslint-disable-next-line no-restricted-globals -- browser code: the undici rule only concerns the Node side
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? { accept: 'application/json' } : { 'content-type': 'application/json', accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = res.ok ? text : { error: `The server answered ${res.status}.` };
    }
  }
  return { status: res.status, data };
};

let transport: Transport = httpTransport;
let downloadInterceptor: ((url: string) => void) | null = null;
let onUnauthorized: (() => void) | null = null;

/** Mock mode only. */
export function installMock(t: Transport, download: (url: string) => void) {
  transport = t;
  downloadInterceptor = download;
}
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: TransportResponse;
  try {
    res = await transport(method, path, body);
  } catch {
    throw new HttpError(0, "Can't reach the server. Check the connection and try again.");
  }
  if (res.status === 401 && path !== '/api/auth/login') onUnauthorized?.();
  if (res.status < 200 || res.status >= 300) {
    const msg = (res.data as ApiError | null)?.error;
    throw new HttpError(res.status, msg || `Something went wrong (error ${res.status}).`);
  }
  return res.data as T;
}

export const api = {
  me: () => request<Me>('GET', '/api/auth/me'),
  login: (b: LoginBody) => request<Me>('POST', '/api/auth/login', b),
  logout: () => request<null>('POST', '/api/auth/logout'),
  catalog: () => request<Catalog>('GET', '/api/catalog'),
  overview: () => request<Overview>('GET', '/api/overview'),
  jobs: () => request<JobSummary[]>('GET', '/api/jobs'),
  job: (id: number) => request<JobDetail>('GET', `/api/jobs/${id}`),
  createJob: (b: CreateJobBody) => request<JobDetail>('POST', '/api/jobs', b),
  cancelJob: (id: number) => request<JobDetail>('POST', `/api/jobs/${id}/cancel`),
  retryJob: (id: number) => request<JobDetail>('POST', `/api/jobs/${id}/retry`),
  rebuildExport: (id: number) => request<JobDetail>('POST', `/api/jobs/${id}/rebuild-export`),
  leads: (id: number) => request<LeadRow[]>('GET', `/api/jobs/${id}/leads`),
  sources: (companyId: number) => request<SourceRow[]>('GET', `/api/companies/${companyId}/sources`),
  users: () => request<UserRow[]>('GET', '/api/users'),
  createUser: (b: CreateUserBody) => request<UserRow>('POST', '/api/users', b),
  updateUser: (id: number, b: UpdateUserBody) => request<UserRow>('PATCH', `/api/users/${id}`, b),
};

export const exportUrl = {
  xlsx: (jobId: number) => `/api/jobs/${jobId}/export.xlsx`,
  csv: (jobId: number, list: LeadList | 'all' = 'all') => `/api/jobs/${jobId}/export.csv?list=${list}`,
};

/** Plain links do the download; mock mode has no server behind them, so it builds the file in the browser. */
export function interceptDownload(url: string): boolean {
  if (!downloadInterceptor) return false;
  downloadInterceptor(url);
  return true;
}
