import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Tests for fetchCurrentRecordByRecordId — the server-side single-record filter.
 *
 * Critical invariant: the function must ONLY return records whose record_id
 * matches the requested recordId. If the Xano server ignores the ?record_id=
 * query parameter and returns all records, we must not blindly pick the first.
 */

const makeRecord = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  created_at: '2026-01-01T00:00:00Z',
  record_id: 'site:index',
  displayName: 'Site Index',
  values: '{"entries":[]}',
  context: {},
  uuid: 'test-uuid',
  lastModified: '2026-01-01T00:00:00Z',
  ...overrides,
});

describe('fetchCurrentRecordByRecordId', () => {
  let fetchCurrentRecordByRecordId: typeof import('../client').fetchCurrentRecordByRecordId;

  beforeEach(async () => {
    // Mock localStorage to set the decrypted endpoint
    const store: Record<string, string> = { eo_xano_ep: 'test_endpoint' };
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v; },
      removeItem: (k: string) => { delete store[k]; },
    });

    vi.resetModules();
    const mod = await import('../client');
    mod.restoreEndpoint();
    fetchCurrentRecordByRecordId = mod.fetchCurrentRecordByRecordId;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns matching record when server returns array with correct record_id', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([makeRecord({ record_id: 'site:index' })]),
    }));
    const result = await fetchCurrentRecordByRecordId('site:index');
    expect(result).not.toBeNull();
    expect(result!.record_id).toBe('site:index');
  });

  it('returns null when server returns array with wrong record_id (filter ignored)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([
        makeRecord({ record_id: 'wiki:operators' }),
        makeRecord({ record_id: 'blog:post-1' }),
      ]),
    }));
    const result = await fetchCurrentRecordByRecordId('site:index');
    expect(result).toBeNull();
  });

  it('returns null when server returns empty array', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
    }));
    const result = await fetchCurrentRecordByRecordId('site:index');
    expect(result).toBeNull();
  });

  it('returns matching record when server returns single object (not array)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(makeRecord({ record_id: 'site:index' })),
    }));
    const result = await fetchCurrentRecordByRecordId('site:index');
    expect(result).not.toBeNull();
    expect(result!.record_id).toBe('site:index');
  });

  it('returns null when server returns single object with wrong record_id', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(makeRecord({ record_id: 'blog:post-1' })),
    }));
    const result = await fetchCurrentRecordByRecordId('site:index');
    expect(result).toBeNull();
  });

  it('picks the most recently modified when multiple matching records', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([
        makeRecord({ record_id: 'site:index', lastModified: '2026-01-01T00:00:00Z' }),
        makeRecord({ record_id: 'site:index', lastModified: '2026-02-01T00:00:00Z' }),
      ]),
    }));
    const result = await fetchCurrentRecordByRecordId('site:index');
    expect(result).not.toBeNull();
    expect(result!.lastModified).toBe('2026-02-01T00:00:00Z');
  });

  it('filters mixed results — only returns records with matching record_id', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([
        makeRecord({ record_id: 'wiki:operators', lastModified: '2026-03-01T00:00:00Z' }),
        makeRecord({ record_id: 'site:index', lastModified: '2026-01-01T00:00:00Z' }),
        makeRecord({ record_id: 'blog:post-1', lastModified: '2026-02-01T00:00:00Z' }),
      ]),
    }));
    const result = await fetchCurrentRecordByRecordId('site:index');
    expect(result).not.toBeNull();
    expect(result!.record_id).toBe('site:index');
  });

  it('throws on HTTP error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve('Internal Server Error'),
    }));
    await expect(fetchCurrentRecordByRecordId('site:index')).rejects.toThrow(/HTTP 500/);
  });
});
