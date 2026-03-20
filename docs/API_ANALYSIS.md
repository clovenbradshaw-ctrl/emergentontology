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
  -> discoverContentRooms()                [Matrix POST /publicRooms]
  -> For each room:
      -> resolveAlias()                    [Matrix GET /directory/room]
      -> fetchRoomEvents()                 [Matrix GET /messages, paginated with retry]
      -> fetchRoomState()                  [Matrix GET /state]
  -> render to static JSON + HTML
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
  Matrix Rooms --fetch_matrix.ts--> Projector
                                       |
  Xano Current --fetch_xano.ts---> Projector
                                       |
                                       v
                               Static JSON files
                            /generated/state/*.json
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

- **Current-state-first**: Xano `eowikicurrent` is the source of truth for reads. The event log (`eowiki`) is secondary/tracking-only.
- **Static-first loading**: Both public site and admin try static JSON before hitting the API, reducing load.
- **Fire-and-forget logging**: `logEvent()` never blocks the UI — failures are console-warned only.
- **In-memory caching**: Admin uses 30s TTL cache (`stateCache.ts`); public site caches permanently per session.
- **Parallel pagination**: Both admin and build tools fetch multiple pages in parallel via `Promise.all`.
- **Retry with backoff**: Build tool (`fetch_matrix.ts`) retries up to 4 times with exponential backoff (1s, 2s, 4s, 8s).
- **Deduplication**: Public site deduplicates by `record_id`, keeping the most recently modified record.
- **AES-256-GCM auth**: The private Xano endpoint path is encrypted in source; password decrypts it at login.

---

## 8. Evaluation: Does This Actually Make Sense?

### What works well

1. **Static-first loading is smart.** The public site tries pre-built JSON before hitting Xano. This means the site works even if Xano is down, and most page loads never touch the API at all. Good resilience.

2. **Current-state-first is pragmatic.** Skipping event replay for reads avoids the complexity and latency of a full event-sourced read path. For a CMS with ~dozens of content items, this is the right call.

3. **Admin cache with 30s TTL is well-designed.** `stateCache.ts` smartly falls back from full-cache lookup to single-record server-side filter to full refetch. Avoids N+1 patterns.

4. **Fire-and-forget event logging doesn't block saves.** The UI stays responsive because `logEvent()` is non-blocking. Since `eowikicurrent` is authoritative, a missed log event doesn't corrupt state.

5. **Suggestion system is cleanly separated.** Own endpoints, own table, no interference with content APIs.

### What doesn't make sense

#### HIGH: No lost-update protection on saves
`upsertCurrentRecord()` (`client.ts:537`) does an unconditional PATCH with no version check, no ETag, no compare-and-swap. If two editors load the same record and both save, the second save silently overwrites the first. The 30s cache TTL makes this worse — Editor A could be working with data that's already been changed by Editor B.

**Concrete scenario:** Editor A loads `wiki:operators` at 0:00. Editor B loads the same record at 0:01 (served from cache). B saves at 0:05. A saves at 0:10. A's save PATCHes using the same Xano row `id` — B's changes are gone, with no warning to either user.

#### HIGH: Matrix is vestigial — code exists but nothing uses it
- The projector (`tools/projector/src/index.ts`) **only imports from `fetch_xano.js`** — `fetch_matrix.ts` is never imported
- The admin editors write to Xano only — no calls to `sendEOEvent()` or `setStateEvent()` from any editor component
- The architecture docs describe Matrix as the "canonical event store" but in practice **Xano is the only store that matters**
- `matrix/client.ts` and `matrix/sdk.ts` are maintained dead code with a full Matrix JS SDK loaded on every admin page

This isn't necessarily wrong — it looks like the system migrated from Matrix-first to Xano-first — but the documentation and code don't reflect reality. The build tool's trigger map in section 5 above is misleading because Matrix calls never actually fire.

#### MEDIUM: Public site fetches ALL records as fallback
When static JSON is missing (e.g., projector hasn't run yet), `loadContentFromApi()` in `site/js/api.js:385` calls `fetchAllXanoRecords()` — paginating through every record at 25/page — just to find one content item. There's no `?record_id=` filter on the public endpoint (`get_eowikicurrent`), unlike the private admin endpoint.

Additionally, `site/js/search.js` duplicates the same pagination logic independently with its own cache, never sharing data with `api.js`.

#### MEDIUM: Event log can silently diverge from current state
`logEvent()` is fire-and-forget. If it fails (network error, Xano outage), the current state in `eowikicurrent` is updated but the event log in `eowiki` is not. There's no retry, no queue, no reconciliation. Over time the event log can become an incomplete record of changes. This is fine if the event log is truly just an audit trail — but if anyone ever tries to replay events to reconstruct state, they'll get wrong results.

#### MEDIUM: No cache-busting on static files
Static JSON files at `/generated/state/*.json` have no version hash, no `?v=` parameter, no ETag validation. After a projector build, users may see stale content until their browser cache expires. The fallback-to-Xano path only triggers on HTTP errors, not on stale data.

#### LOW: Xano auth is a shared secret, not per-user
All editors share the same Bearer token (SHA-256 of the decrypted endpoint path). There's no way to attribute writes to individual users at the Xano level. Matrix auth exists separately but isn't wired into the write path. The `agent` field in `context` is set from `settings.displayName` — a client-side string anyone can change.

#### LOW: Suggestion endpoint has no rate limiting
`POST /eo_wiki_suggestions` accepts unauthenticated requests with no rate limiting. A script could flood the suggestions table. Low severity because the impact is limited to the suggestions feature.

### Verdict

**The architecture fundamentally works** for its current scale (small team, dozens of content items, moderate traffic). The static-first + Xano-current-state pattern is pragmatic and resilient.

**The main risks are:**
1. Lost updates if multiple editors are active (no optimistic locking)
2. Confusion from Matrix code that's present but unused
3. Inefficient fallback paths on the public site when static files are missing

**If this system needs to scale or support concurrent editing**, the highest-priority fix would be adding a `lastModified` check to `upsertCurrentRecord()` before PATCHing. Everything else is manageable at current scale.
