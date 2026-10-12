import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, buildUrl, errorMessage, onUnauthorized } from '../lib/api';

function mockFetch(status: number, body: unknown) {
  const fn = vi.fn(async (..._args: unknown[]) => new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
  onUnauthorized(null);
});

describe('api client', () => {
  it('sends X-CSRF on non-GET, same-origin credentials, JSON body', async () => {
    const f = mockFetch(201, { ok: true });
    await api.post('/api/things', { a: 1 });
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/things');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('same-origin');
    expect((init.headers as Record<string, string>)['X-CSRF']).toBe('1');
    expect(init.body).toBe('{"a":1}');
  });
  it('does not send X-CSRF on GET and builds query strings without empty values', async () => {
    const f = mockFetch(200, { x: 1 });
    await api.get('/api/events', { status: 'verified', employee_id: undefined, branch_id: '', limit: 50 });
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/events?status=verified&limit=50');
    expect((init.headers as Record<string, string>)['X-CSRF']).toBeUndefined();
  });
  it('surfaces the server message and code from error bodies', async () => {
    mockFetch(409, { error: 'staff_id_taken', message: 'Staff ID DB-001 is already used' });
    const err = (await api.post('/api/employees', {}).catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(409);
    expect(err.code).toBe('staff_id_taken');
    expect(errorMessage(err)).toBe('Staff ID DB-001 is already used');
  });
  it('formats validation issues per field', async () => {
    mockFetch(400, { error: 'validation_failed', message: 'Some fields are invalid', details: { issues: [{ path: 'password', message: 'Use at least 10 characters' }] } });
    const err = (await api.post('/api/auth/signup', {}).catch((e: unknown) => e)) as ApiError;
    expect(errorMessage(err)).toBe('Password: Use at least 10 characters');
  });
  it('calls the unauthorized handler on 401 (but not for a failed login)', async () => {
    const h = vi.fn();
    onUnauthorized(h);
    mockFetch(401, { error: 'unauthenticated', message: 'Please sign in' });
    await api.get('/api/overview').catch(() => {});
    expect(h).toHaveBeenCalledTimes(1);
    mockFetch(401, { error: 'invalid_credentials', message: 'Email or password is incorrect' });
    await api.post('/api/auth/login', {}).catch(() => {});
    expect(h).toHaveBeenCalledTimes(1);
  });
  it('handles non-JSON 5xx bodies and network failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>bad gateway</html>', { status: 502 })));
    const err = (await api.get('/api/x').catch((e: unknown) => e)) as ApiError;
    expect(err.status).toBe(502);
    expect(errorMessage(err)).toMatch(/server had a problem/);
    expect(errorMessage(new TypeError('Failed to fetch'))).toMatch(/Could not reach the server/);
  });
  it('buildUrl appends to existing query', () => {
    expect(buildUrl('/a?b=1', { c: 2 })).toBe('/a?b=1&c=2');
  });
});
