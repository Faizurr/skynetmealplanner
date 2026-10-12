/** Thin fetch wrapper for the attendance API (cookie auth + CSRF header). */

export interface ValidationIssue {
  path: string;
  message: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;
  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
  /** Field-level validation issues (400 validation_failed). */
  get issues(): ValidationIssue[] {
    const raw = (this.details as { issues?: unknown } | undefined)?.issues;
    return Array.isArray(raw) ? (raw as ValidationIssue[]) : [];
  }
}

type Params = Record<string, string | number | boolean | null | undefined>;

let unauthorizedHandler: (() => void) | null = null;
/** Called on any 401 so the app can return to the sign-in screen. */
export function onUnauthorized(fn: (() => void) | null) {
  unauthorizedHandler = fn;
}

export function buildUrl(path: string, params?: Params): string {
  if (!params) return path;
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `${path}${path.includes('?') ? '&' : '?'}${s}` : path;
}

/** Converts any thrown value into a user-facing sentence. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    const issues = err.issues;
    if (issues.length) return issues.map((i) => (i.path ? `${humanizeField(i.path)}: ${i.message}` : i.message)).join('. ');
    return err.message;
  }
  if (err instanceof TypeError) return 'Could not reach the server. Check your connection and try again.';
  if (err instanceof Error && err.name === 'AbortError') return 'Request cancelled';
  if (err instanceof Error) return err.message;
  return 'Something went wrong. Please try again.';
}

function humanizeField(p: string): string {
  const last = p.split('.').pop() ?? p;
  const s = last.replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export async function parseResponse<T>(res: Response): Promise<T> {
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  if (!res.ok) {
    const b = (body ?? {}) as { error?: string; message?: string; details?: Record<string, unknown> };
    const fallback = res.status >= 500 ? 'The server had a problem. Please try again.' : `Request failed (${res.status})`;
    throw new ApiError(res.status, b.error ?? `http_${res.status}`, b.message ?? fallback, b.details);
  }
  return body as T;
}

export async function request<T>(method: string, path: string, opts: { params?: Params; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (method !== 'GET' && method !== 'HEAD') headers['X-CSRF'] = '1';
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(buildUrl(path, opts.params), {
    method,
    headers,
    credentials: 'same-origin',
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
  });
  try {
    return await parseResponse<T>(res);
  } catch (e) {
    if (e instanceof ApiError && e.status === 401 && !path.startsWith('/api/auth/login') && !path.startsWith('/api/auth/change-password')) {
      unauthorizedHandler?.();
    }
    throw e;
  }
}

export const api = {
  get: <T>(path: string, params?: Params, signal?: AbortSignal) => request<T>('GET', path, { params, signal }),
  post: <T>(path: string, body: unknown = {}) => request<T>('POST', path, { body }),
  put: <T>(path: string, body: unknown = {}) => request<T>('PUT', path, { body }),
  patch: <T>(path: string, body: unknown = {}) => request<T>('PATCH', path, { body }),
  del: <T>(path: string) => request<T>('DELETE', path),
};

/** Downloads a GET endpoint as a file (keeps cookie auth; surfaces API errors). */
export async function downloadFile(path: string, params: Params | undefined, fallbackName: string): Promise<string> {
  const res = await fetch(buildUrl(path, params), { credentials: 'same-origin' });
  if (!res.ok) await parseResponse(res);
  const cd = res.headers.get('Content-Disposition') ?? '';
  const m = /filename="?([^";]+)"?/i.exec(cd);
  const name = m?.[1] ?? fallbackName;
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return name;
}
