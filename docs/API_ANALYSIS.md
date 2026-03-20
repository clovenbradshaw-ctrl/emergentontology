# API Analysis — Emergent Ontology

## Context

This document maps every external API call in the codebase: what it calls, when it fires, and the data flow between services. The project is an **event-sourced CMS** with three tiers: **Matrix** (canonical event store), **Xano** (current-state snapshots for fast reads), and **static JSON** (pre-built for the public site).

---

## 1. External Services

| Service | Base URL | Auth | Role |
|---------|----------|------|------|
| **Xano** | `https://xvkq-pq7i-idtl.n7d.xano.io/api:GGzWIVAW` | Bearer (SHA-256 of decrypted endpoint) | Current-state DB, event log |
| **Matrix** | User-provided homeserver (e.g. `https://hyphae.social`) | Matrix access_token | Canonical event store |
| **Substack** | `https://emergentontology.substack.com/feed` | None | Blog RSS feed |
| **GitHub** | `api.github.com` / `raw.githubusercontent.com` | None | Corpus data (UD treebanks, FLORES) |
| **Anthropic** | SDK | API key | Clause classification (Claude) |
| **OpenAI** | SDK | API key | Clause classification (GPT-4o) |
| **Google Gemini** | Via OpenAI-compat endpoint | API key | Clause classification (Gemini) |

---

## 2. Xano API — All Endpoints

### Reads (no auth for public, decrypted path for private)

| Endpoint | Method | File | When it fires |
|----------|--------|------|---------------|
| `GET /get_public_eowiki` | GET | `admin/src/xano/client.ts:194` | `fetchAllRecords()` — loads event log for revision history |
| `GET /get_eowikicurrent?page=N` | GET | `site/js/api.js:120` | Public site page load — paginated fetch of all current-state records |
| `GET /{decrypted_endpoint}` | GET | `admin/src/xano/client.ts:291` | Admin editor load — fetches current-state via private paginated endpoint |
| `GET /{decrypted_endpoint}?record_id=X` | GET | `admin/src/xano/client.ts:400` | Single record fetch by ID (used by editor load, upsert dedup) |
| `GET /get_eowikicurrent` | GET | `site/js/search.js:20` | Search index build — fetches all records for Fuse.js |
| `GET /eowiki_suggestions` | GET | `site/js/suggest.js:57` | Fetch user suggestions |

### Writes (require Bearer auth)

| Endpoint | Method | File | When it fires |
|----------|--------|------|---------------|
| `POST /eowiki` | POST | `admin/src/xano/client.ts:218` | `logEvent()` — fire-and-forget after every save (change tracking) |
| `POST /eowikicurrent` | POST | `admin/src/xano/client.ts:476` | `createCurrentRecord()` — first save of a new content entity |
| `PATCH /eowikicurrent/{id}` | PATCH | `admin/src/xano/client.ts:501` | `patchCurrentRecord()` — update existing content entity |
| `POST /eo_wiki_suggestions` | POST | `site/js/suggest.js:45` | User submits a suggestion from public site |

### Xano in the Build Tool

| Endpoint | Method | File | When it fires |
|----------|--------|------|---------------|
| `GET /{endpoint}?page=N&per_page=200` | GET | `tools/projector/src/fetch_xano.ts:85` | `fetchAllCurrentRecords()` — build-time fetch of all records (parallel pages) |
| `GET /{endpoint}?record_id=X` | GET | `tools/projector/src/fetch_xano.ts:125` | `fetchCurrentRecordByRecordId()` — build-time single record lookup |

---

## 3. Matrix API — All Endpoints

### Auth

| Endpoint | Method | File | When it fires |
|----------|--------|------|---------------|
| `POST /_matrix/client/v3/login` | POST | `admin/src/matrix/client.ts:61` | User submits Matrix login form |
| `POST /_matrix/client/v3/logout` | POST | `admin/src/matrix/client.ts:98` | User clicks logout |

### Room Operations

| Endpoint | Method | File | When it fires |
|----------|--------|------|---------------|
| `GET /_matrix/client/v3/directory/room/{alias}` | GET | `admin/src/matrix/client.ts:116` | Resolve room alias to room ID (on editor load, room setup) |
| `POST /_matrix/client/v3/createRoom` | POST | `admin/src/matrix/client.ts:128` | `createRoom()` — admin creates new content room |
| `GET /_matrix/client/v3/rooms/{roomId}/state` | GET | `admin/src/matrix/client.ts:227` | `fetchRoomState()` — load room metadata |
| `GET /_matrix/client/v3/rooms/{roomId}/state/m.room.power_levels/` | GET | `admin/src/matrix/client.ts:247` | `checkWriteAccess()` — UX check before editing |
| `GET /_matrix/client/v3/rooms/{roomId}/messages` | GET | `admin/src/matrix/client.ts:212` | `fetchRoomDelta()` — delta sync of eo.op events |
| `PUT /_matrix/client/v3/rooms/{roomId}/send/eo.op/{txnId}` | PUT | `admin/src/matrix/client.ts:157` | `sendEOEvent()` — publish a content edit event |
| `PUT /_matrix/client/v3/rooms/{roomId}/state/{type}/{key}` | PUT | `admin/src/matrix/client.ts:181` | `setStateEvent()` — set content metadata state |

### Matrix in the Build Tool

| Endpoint | Method | File | When it fires |
|----------|--------|------|---------------|
| `GET /_matrix/client/v3/directory/room/{alias}` | GET | `tools/projector/src/fetch_matrix.ts:69` | Build-time alias resolution |
| `GET /_matrix/client/v3/rooms/{roomId}/messages` | GET | `tools/projector/src/fetch_matrix.ts:86` | Build-time event history (paginated, with retry) |
| `GET /_matrix/client/v3/rooms/{roomId}/state` | GET | `tools/projector/src/fetch_matrix.ts:115` | Build-time room state fetch |
| `POST /_matrix/client/v3/publicRooms` | POST | `tools/projector/src/fetch_matrix.ts:141` | `discoverContentRooms()` — build-time room discovery |

---

## 4. Other APIs

| API | File | When it fires |
|-----|------|---------------|
| **Substack RSS** (`/feed`) | `site/js/api.js:446` | `loadSubstackFeed()` — home page render, called in parallel with index load |
| **Static JSON** (`/generated/state/*.json`) | `site/js/api.js:222,368` | First-priority on every page load (before Xano fallback) |
| **Search index** (`/generated/search_index.json`) | `site/js/search.js:55` | `ensureFuse()` — first search attempt loads static index |
| **Fuse.js CDN** | `site/js/search.js:45` | Lazy-loaded on first search interaction |
| **GitHub UD treebanks** | `data/app.py:505` | Python analysis tool — download corpus archives |
| **GitHub FLORES-101** | `data/app.py:640` | Python analysis tool — download devtest files |
| **Anthropic Claude API** | `data/app.py:844` | Clause classification in analysis tool |
| **OpenAI GPT-4o API** | `data/app.py:859` | Clause classification in analysis tool |

---

## 5. When APIs Fire — Trigger Map

### On Page Load (Public Site)
```
Browser navigates to site
  -> loadIndex()                          [static JSON first, Xano fallback]
  -> loadHomeConfig()                     [static /generated/home.json]
  -> loadSubstackFeed()                   [RSS fetch, parallel with index]
  -> route resolves -> loadContent(id)    [static JSON first, Xano fallback]
```

### On Page Load (Admin Editor)
```
Browser opens admin
  -> AuthContext useEffect -> loadSession() -> restoreEndpoint()  [localStorage]
  -> If authenticated:
      -> Editor useEffect -> loadState(contentId)
          -> fetchCurrentRecordCached(contentId)                [Xano private GET]
          -> fallback: fetch static JSON
          -> applyFreshnessUpdate()                             [background Xano check]
          -> fetchRevisionHistory(contentId)                    [Xano GET /get_public_eowiki]
      -> loadState('site:index')                                [for link picker / nav]
```

### On Login (Admin)
```
User submits password
  -> verifyPassword(pw)
      -> decryptEndpoint(pw)              [AES-256-GCM decrypt, no network]
      -> deriveAuthHash(ep)               [SHA-256 hash, no network]
      -> localStorage persist
```

### On Save (Admin Editor — any content type)
```
User clicks Save
  -> upsertCurrentRecord(recordId, snapshot, agent, existing)
      -> patchCurrentRecord(id, payload)   [PATCH /eowikicurrent/{id}]
        OR
      -> createCurrentRecord(payload)      [POST /eowikicurrent]
  -> logEvent(payload)                     [fire-and-forget POST /eowiki]
  -> _onRecordWritten(result)              [update in-memory cache]
```

### On Search (Admin — Global Search & Replace)
```
User clicks Search
  -> invalidateCurrentCache()
  -> fetchAllCurrentRecordsCached()        [Xano private GET, all pages]
  -> client-side scan of all record values
```

### On Replace (Admin — Global Search & Replace)
```
User clicks Replace
  -> For each selected match:
      -> upsertCurrentRecord()             [PATCH or POST]
      -> logEvent()                        [fire-and-forget POST]
```

### On Search (Public Site)
```
User types in search box
  -> ensureFuse()                          [one-time: load Fuse.js CDN + search index]
      -> fetch /generated/search_index.json [static first]
      -> fallback: fetchAllXanoPages()     [paginated GET /get_eowikicurrent]
  -> fuse.search(query)                    [client-side, no network]
```

### On Build (Projector Tool)
```
npm run build
  -> fetchAllCurrentRecords()              [Xano paginated GET, parallel pages]
  -> parse site:index and content records
  -> render to static JSON + HTML

NOTE: fetch_matrix.ts exists with full implementations (discoverContentRooms,
resolveAlias, fetchRoomEvents, fetchRoomState) but is NEVER IMPORTED by
index.ts. The projector reads only from Xano, not Matrix.
```

### On Suggestion Submit (Public Site)
```
User submits suggestion form
  -> postSuggestionEvent()                 [POST /eo_wiki_suggestions]
```

---

## 6. Data Flow Diagram

```
                        BUILD TIME
  -------------------------------------------------------
  Xano Current --fetch_xano.ts---> Projector
                                       |
                                       v
                               Static JSON files
                            /generated/state/*.json

  (fetch_matrix.ts exists but is NOT imported by index.ts)
  -------------------------------------------------------
                             |
                             v
                   PUBLIC SITE (read-only)

  1. Try static JSON (/generated/state/...)
  2. Fallback -> Xano GET /get_eowikicurrent (paginated)
  3. Substack RSS feed (home page only)
  4. Suggestions POST (user submissions)

  -------------------------------------------------------

                  ADMIN EDITOR (read/write)

  Reads:  Xano GET /{private_endpoint} (cached, 30s TTL)
          Xano GET /get_public_eowiki (revision history)
          Static JSON fallback

  Writes: Xano PATCH /eowikicurrent/{id}  (primary)
          Xano POST  /eowikicurrent       (create)
          Xano POST  /eowiki              (event log, fire&forget)

  -------------------------------------------------------

                  DATA ANALYSIS (Python)

  GitHub -> UD treebanks, FLORES corpus
  Anthropic -> Claude classification
  OpenAI -> GPT-4o / Gemini classification
```

---

## 7. Key Patterns

- **Event log as intended canonical source**: The public event log (`GET /get_public_eowiki`) is designed to be the canonical source from which current state is generated. In practice, `eowikicurrent` snapshots have become the de facto source of truth, with the event log written fire-and-forget.
- **Static-first loading**: Both public site and admin try static JSON before hitting the API, reducing load.
- **Fire-and-forget logging**: `logEvent()` never blocks the UI — failures are console-warned only.
- **In-memory caching**: Admin uses 30s TTL cache (`stateCache.ts`); public site caches permanently per session.
- **Parallel pagination**: Both admin and build tools fetch multiple pages in parallel via `Promise.all`.
- **Retry with backoff**: Build tool (`fetch_matrix.ts`) retries up to 4 times with exponential backoff (1s, 2s, 4s, 8s).
- **Deduplication**: Public site deduplicates by `record_id`, keeping the most recently modified record.
- **AES-256-GCM auth**: The private Xano endpoint path is encrypted in source; password decrypts it at login.

---

## 8. Evaluation: Does This Actually Make Sense?

### The intended architecture vs. reality

The system was designed as **event-sourced**: the public event log (`GET /get_public_eowiki`) is the canonical public source of truth, and current state should be *generated* from it by replaying events. Evidence for this intent:

- A full replay engine exists at `admin/src/eo/replay.ts` — `applyDelta()` handles page blocks (INS/ALT/NUL with JSON patch), wiki revisions, experiment entries, and blog posts. Complete, working code.
- `xanoToRaw()` in `client.ts:609` converts Xano event records into `EORawEvent` format ready for replay.
- The suggestion system (`site/js/suggest.js`) **actually works this way**: `replaySuggestions()` takes raw events from `GET /eowiki_suggestions` and replays them client-side to build current suggestion state — INS creates, SIG upvotes, NUL deletes. This is the intended pattern, fully working.
- Matrix was the original event store; `fetch_matrix.ts` in the projector has complete room discovery and event pagination.
- The types in `admin/src/eo/types.ts` define `EORawEvent`, `EOEvent`, and `ProjectedContent` — the full event-sourced vocabulary.

**But the code has drifted to current-state-first**, bypassing the event log:

- `applyFreshnessUpdate()` in `stateCache.ts:311` is marked `@deprecated` — always returns `hadUpdates: false`, never applies delta events. Comment: "current-state snapshot is authoritative, events are for tracking only."
- `replay.ts` is **completely unused** — no file imports `applyDelta()`.
- The projector (`tools/projector/src/index.ts`) only imports from `fetch_xano.js` (current-state snapshots) — `fetch_matrix.ts` is never imported despite existing with full implementations.
- Admin editors save directly to `eowikicurrent` as the primary write, with `logEvent()` to the event log as fire-and-forget.

**The result: the architecture claims to be event-sourced but isn't.** The event log is written to, but nothing reads it back to generate state (except the suggestion system and revision history display).

### What works well

1. **Static-first loading.** The public site tries pre-built JSON before hitting any API. Site works even if Xano is down.

2. **The suggestion system is the architectural model.** `suggest.js:replaySuggestions()` replays events to build state — this is how the rest of the system was designed to work. It's cleanly separated, correctly implemented, and proves the event-replay pattern works.

3. **Admin cache with 30s TTL is well-designed.** `stateCache.ts` smartly falls back from full-cache lookup to single-record server-side filter to full refetch. Avoids N+1 patterns.

4. **The replay engine is solid code.** `eo/replay.ts` handles INS/ALT/NUL operations, JSON patch application, block ordering, and all content types. It's just not wired up.

### What doesn't make sense

#### CRITICAL: Event log and current state can diverge with no recovery
The event log (`get_public_eowiki`) is written via fire-and-forget `logEvent()` (`client.ts:237`). If it fails — network error, timeout, Xano outage — the event is silently lost (only a `console.warn`). Meanwhile `eowikicurrent` is updated successfully. Over time the event log becomes an incomplete record:
- The public API (`get_public_eowiki`) can serve stale/incomplete data
- There's no reconciliation mechanism to detect or repair gaps
- If replay were re-enabled, it would produce wrong state from incomplete events
- No retry queue, no "write events BEFORE snapshots" guarantee

#### HIGH: The replay pipeline is disconnected
The intended flow was: `events → replay → current state`. The actual flow is: `editor → direct snapshot write → current state`. Specifically:
- `replay.ts` with its complete `applyDelta()` function is never imported
- `applyFreshnessUpdate()` was the bridge between event log and state but is now deprecated
- The projector builds static files from `eowikicurrent` snapshots, not from event replay
- `fetch_matrix.ts` in the projector has full implementations but is never called

#### HIGH: No lost-update protection on saves
`upsertCurrentRecord()` (`client.ts:537`) does an unconditional PATCH with no version check, no ETag, no compare-and-swap. Two editors can silently overwrite each other. The 30s cache TTL makes this worse — stale reads lead to stale writes.

#### MEDIUM: Public site fetches ALL records as fallback
When static JSON is missing, `loadContentFromApi()` in `site/js/api.js:385` fetches ALL records (paginated 25/page) just to find one content item. No `?record_id=` filter on the public endpoint. `site/js/search.js` duplicates the same pagination logic with its own independent cache.

#### MEDIUM: No cache-busting on static files
Static JSON files have no version hash or ETag validation. After a projector build, users may see stale content until browser cache expires.

### Verdict

**The system works but has drifted from its design.** The event-sourced architecture is partially built — the replay engine exists, the event log is written to, the types are defined, and the suggestion system proves the pattern works — but the main content pipeline is disconnected from it. In practice, `eowikicurrent` direct snapshots have become the source of truth, making the event log unreliable as a canonical source.

**The biggest risk:** The public event log endpoint (`get_public_eowiki`) may not accurately reflect the site's current state because events are written fire-and-forget and nothing verifies completeness.

**To make the architecture match its intent:**
1. Make `logEvent()` reliable — retry with backoff, or write events BEFORE snapshots, or use a write-ahead pattern
2. Re-enable `replay.ts` as the way to derive current state (at minimum for the projector build), or explicitly abandon event sourcing and document the current-state-first approach as intentional
3. Add `lastModified` conflict detection to `upsertCurrentRecord()` to prevent lost updates
4. Wire the projector to verify events against snapshots during builds (detect divergence)
