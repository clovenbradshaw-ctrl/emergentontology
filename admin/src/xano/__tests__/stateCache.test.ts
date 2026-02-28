import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Tests for the state cache layer — the critical fallback chain:
 *   1. Single-record fetch (server-side ?record_id= filter)
 *   2. Full fetch (download all records, search client-side)
 *   3. Static fallback (/generated/state/ files)
 *
 * The key invariant: if the single-record fetch returns null (not an error),
 * the cache MUST fall back to the full fetch before giving up.
 */

const makeRecord = (record_id: string, values: unknown = { entries: [] }, lastModified = '2026-01-01T00:00:00Z') => ({
  id: 1,
  created_at: '2026-01-01T00:00:00Z',
  record_id,
  displayName: record_id,
  values: JSON.stringify(values),
  context: {},
  uuid: 'test-uuid',
  lastModified,
});

describe('fetchCurrentRecordCached', () => {
  let fetchCurrentRecordCached: typeof import('../stateCache').fetchCurrentRecordCached;
  let invalidateCurrentCache: typeof import('../stateCache').invalidateCurrentCache;
  let mockFetchByRecordId: ReturnType<typeof vi.fn>;
  let mockFetchAll: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    mockFetchByRecordId = vi.fn();
    mockFetchAll = vi.fn();

    vi.doMock('../client', () => ({
      fetchCurrentRecordByRecordId: mockFetchByRecordId,
      fetchAllCurrentRecords: mockFetchAll,
      fetchFilteredCurrentRecords: vi.fn().mockResolvedValue([]),
      fetchAllRecords: vi.fn().mockResolvedValue([]),
      xanoToRaw: vi.fn(),
      upsertCurrentRecord: vi.fn(),
      _registerCacheHook: vi.fn(),
      _registerCacheLookup: vi.fn(),
    }));

    const mod = await import('../stateCache');
    fetchCurrentRecordCached = mod.fetchCurrentRecordCached;
    invalidateCurrentCache = mod.invalidateCurrentCache;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the record when single-record fetch succeeds', async () => {
    const record = makeRecord('site:index');
    mockFetchByRecordId.mockResolvedValue(record);
    const result = await fetchCurrentRecordCached('site:index');
    expect(result).toEqual(record);
    expect(mockFetchAll).not.toHaveBeenCalled();
  });

  it('falls back to full fetch when single-record fetch returns null', async () => {
    const record = makeRecord('site:index');
    mockFetchByRecordId.mockResolvedValue(null);
    mockFetchAll.mockResolvedValue([record]);
    const result = await fetchCurrentRecordCached('site:index');
    expect(result).toEqual(record);
    expect(mockFetchAll).toHaveBeenCalled();
  });

  it('falls back to full fetch when single-record fetch throws', async () => {
    const record = makeRecord('site:index');
    mockFetchByRecordId.mockRejectedValue(new Error('Network error'));
    mockFetchAll.mockResolvedValue([record]);
    const result = await fetchCurrentRecordCached('site:index');
    expect(result).toEqual(record);
    expect(mockFetchAll).toHaveBeenCalled();
  });

  it('returns null when both single and full fetch find nothing', async () => {
    mockFetchByRecordId.mockResolvedValue(null);
    mockFetchAll.mockResolvedValue([]);
    const result = await fetchCurrentRecordCached('site:index');
    expect(result).toBeNull();
  });

  it('uses single-record cache on repeated calls within TTL', async () => {
    const record = makeRecord('site:index');
    mockFetchByRecordId.mockResolvedValue(record);

    const first = await fetchCurrentRecordCached('site:index');
    const second = await fetchCurrentRecordCached('site:index');

    expect(first).toEqual(record);
    expect(second).toEqual(record);
    expect(mockFetchByRecordId).toHaveBeenCalledTimes(1);
  });

  it('selects correct record from full fetch when multiple records exist', async () => {
    const target = makeRecord('site:index');
    const other = makeRecord('wiki:operators');
    mockFetchByRecordId.mockResolvedValue(null);
    mockFetchAll.mockResolvedValue([other, target]);
    const result = await fetchCurrentRecordCached('site:index');
    expect(result).toEqual(target);
  });
});

describe('fetchFilteredRecordsCached — client-side fallback', () => {
  let fetchFilteredRecordsCached: typeof import('../stateCache').fetchFilteredRecordsCached;
  let mockFetchFiltered: ReturnType<typeof vi.fn>;
  let mockFetchAll: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    mockFetchFiltered = vi.fn();
    mockFetchAll = vi.fn();

    vi.doMock('../client', () => ({
      fetchCurrentRecordByRecordId: vi.fn().mockResolvedValue(null),
      fetchAllCurrentRecords: mockFetchAll,
      fetchFilteredCurrentRecords: mockFetchFiltered,
      fetchAllRecords: vi.fn().mockResolvedValue([]),
      xanoToRaw: vi.fn(),
      upsertCurrentRecord: vi.fn(),
      _registerCacheHook: vi.fn(),
      _registerCacheLookup: vi.fn(),
    }));

    const mod = await import('../stateCache');
    fetchFilteredRecordsCached = mod.fetchFilteredRecordsCached;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('matches records with flat context.status (new format)', async () => {
    mockFetchFiltered.mockRejectedValue(new Error('server filter broken'));
    mockFetchAll.mockResolvedValue([{
      id: 1, created_at: '', record_id: 'wiki:test', displayName: 'Test',
      values: '{}', uuid: 'u', lastModified: '',
      context: { status: 'published', visibility: 'public' },
    }]);
    const result = await fetchFilteredRecordsCached({ status: 'published', content_type: 'wiki' });
    expect(result).toHaveLength(1);
  });

  it('matches records with nested context.meta (legacy format)', async () => {
    mockFetchFiltered.mockRejectedValue(new Error('server filter broken'));
    mockFetchAll.mockResolvedValue([{
      id: 1, created_at: '', record_id: 'wiki:test', displayName: 'Test',
      values: '{}', uuid: 'u', lastModified: '',
      context: { meta: { status: 'published', visibility: 'public' } },
    }]);
    const result = await fetchFilteredRecordsCached({ status: 'published', content_type: 'wiki' });
    expect(result).toHaveLength(1);
  });

  it('matches records with both formats present (flat takes precedence)', async () => {
    mockFetchFiltered.mockRejectedValue(new Error('server filter broken'));
    mockFetchAll.mockResolvedValue([{
      id: 1, created_at: '', record_id: 'wiki:test', displayName: 'Test',
      values: '{}', uuid: 'u', lastModified: '',
      context: { status: 'published', visibility: 'public', meta: { status: 'draft', visibility: 'private' } },
    }]);
    // Flat context.status = 'published' should match even though meta.status = 'draft'
    const result = await fetchFilteredRecordsCached({ status: 'published', content_type: 'wiki' });
    expect(result).toHaveLength(1);
  });

  it('excludes records that do not match status filter', async () => {
    mockFetchFiltered.mockRejectedValue(new Error('server filter broken'));
    mockFetchAll.mockResolvedValue([{
      id: 1, created_at: '', record_id: 'wiki:test', displayName: 'Test',
      values: '{}', uuid: 'u', lastModified: '',
      context: { status: 'draft', meta: { status: 'draft' } },
    }]);
    const result = await fetchFilteredRecordsCached({ status: 'published', content_type: 'wiki' });
    expect(result).toHaveLength(0);
  });

  it('filters by content_type based on record_id prefix', async () => {
    mockFetchFiltered.mockRejectedValue(new Error('server filter broken'));
    mockFetchAll.mockResolvedValue([
      {
        id: 1, created_at: '', record_id: 'wiki:test', displayName: 'Test',
        values: '{}', uuid: 'u', lastModified: '',
        context: { status: 'published' },
      },
      {
        id: 2, created_at: '', record_id: 'blog:post', displayName: 'Post',
        values: '{}', uuid: 'u', lastModified: '',
        context: { status: 'published' },
      },
    ]);
    const result = await fetchFilteredRecordsCached({ content_type: 'wiki' });
    expect(result).toHaveLength(1);
    expect(result[0].record_id).toBe('wiki:test');
  });
});

describe('loadState', () => {
  let loadState: typeof import('../stateCache').loadState;
  let mockFetchByRecordId: ReturnType<typeof vi.fn>;
  let mockFetchAll: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    mockFetchByRecordId = vi.fn();
    mockFetchAll = vi.fn();

    vi.doMock('../client', () => ({
      fetchCurrentRecordByRecordId: mockFetchByRecordId,
      fetchAllCurrentRecords: mockFetchAll,
      fetchFilteredCurrentRecords: vi.fn().mockResolvedValue([]),
      fetchAllRecords: vi.fn().mockResolvedValue([]),
      xanoToRaw: vi.fn(),
      upsertCurrentRecord: vi.fn(),
      _registerCacheHook: vi.fn(),
      _registerCacheLookup: vi.fn(),
    }));

    // Mock global fetch for static fallback (returns 404)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));

    const mod = await import('../stateCache');
    loadState = mod.loadState;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns state from current record when single-record fetch works', async () => {
    const state = { entries: [{ content_id: 'wiki:test' }] };
    mockFetchByRecordId.mockResolvedValue(makeRecord('site:index', state));
    const result = await loadState('site:index', '');
    expect(result.source).toBe('current');
    expect(result.state).toEqual(state);
  });

  it('returns state via full fetch when single-record returns null', async () => {
    const state = { entries: [{ content_id: 'wiki:test' }] };
    mockFetchByRecordId.mockResolvedValue(null);
    mockFetchAll.mockResolvedValue([makeRecord('site:index', state)]);
    const result = await loadState('site:index', '');
    expect(result.source).toBe('current');
    expect(result.state).toEqual(state);
  });

  it('returns source:"none" when all sources fail', async () => {
    mockFetchByRecordId.mockResolvedValue(null);
    mockFetchAll.mockResolvedValue([]);
    const result = await loadState('site:index', '');
    expect(result.source).toBe('none');
    expect(result.state).toBeNull();
  });
});
