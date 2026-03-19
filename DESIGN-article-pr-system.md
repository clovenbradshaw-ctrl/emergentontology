# Article PR Submission System — Design

## Overview

A system allowing outside users to submit "pull requests" on articles (wiki, blog), which an admin can review, edit, and approve — with full provenance and edit history visible throughout.

Suggestions live in a **separate Xano table** (`eowiki_suggestions`) — completely sandboxed from the canonical content in `eowikicurrent` and `eowiki`. Only when an admin explicitly merges a suggestion does it produce events in the real event log and update `eowikicurrent`.

---

## 1. Data Model

### 1.1 Storage: `eowiki_suggestions` table (Xano)

Suggestions use their own append-only event log with the same column schema as `eowiki`:

| Column | Type | Description |
|--------|------|-------------|
| `created_at` | timestamp | Auto-set by Xano |
| `op` | text | EO operator (`INS`, `SIG`, `ALT`, `NUL`) |
| `subject` | text | Target path, e.g. `suggestion:<id>` or `suggestion:<id>/rev:r_N` |
| `predicate` | text | Always `eo.op` |
| `value` | text | JSON-stringified operand |
| `context` | json | `{agent, ts, agent_name, agent_contact?, ip?, ...}` |

**Endpoints (already created):**
- `POST /eo_wiki_suggestions` — append a suggestion event (public, no auth)
- `GET /eowiki_suggestions` — list all suggestion events (public, used by admin)
- `GET /eowiki_suggestions/{id}` — get single event by ID

### 1.2 Suggestion lifecycle as events

A suggestion's full history is a sequence of events in `eowiki_suggestions`, replayed to derive current state — same pattern as the main content system.

**Initial submission** (public, no auth):
```
INS  suggestion:sg_abc123/rev:r_1
     operand: {
       target_content_id: "wiki:operators",
       target_revision_id: "r_10",        // base revision (what they forked from)
       format: "markdown",
       content: "# Operators\n\nThe nine...",
       summary: "Added SUP operator example"
     }
     context: {
       agent: "sg_abc123",                // suggestion ID as agent
       agent_name: "alice",               // or "anonymous" if not provided
       agent_contact: "alice@example.com", // optional
       ts: "2026-03-19T10:00:00Z",
       ip: "..."                          // for rate limiting / abuse tracking
     }
```

**Submitter revises their suggestion** (with token):
```
INS  suggestion:sg_abc123/rev:r_2
     operand: { format, content, summary: "Fixed typo I introduced" }
     context: { agent_name: "alice", ts: "..." }
```

**Admin changes status** (auth required):
```
SIG  suggestion:sg_abc123
     operand: { set: { status: "in_review" } }
     context: { agent: "admin", ts: "..." }
```

**Admin edits the suggestion content** (auth required):
```
INS  suggestion:sg_abc123/rev:r_3
     operand: { format, content, summary: "admin: tightened intro" }
     context: { agent: "admin", ts: "..." }
```

**Admin rejects**:
```
SIG  suggestion:sg_abc123
     operand: { set: { status: "rejected", reason: "Out of scope" } }
     context: { agent: "admin", ts: "..." }
```

**Admin merges** — this is the bridge event. Two things happen:
1. In `eowiki_suggestions`:
   ```
   SIG  suggestion:sg_abc123
        operand: { set: { status: "merged", merged_as: "r_15" } }
        context: { agent: "admin", ts: "..." }
   ```
2. In the real `eowiki` + `eowikicurrent` (via existing admin write path):
   ```
   INS  wiki:operators/rev:r_15
        operand: {
          format: "markdown",
          content: "<final merged content>",
          summary: "Merged suggestion sg_abc123 by alice: Added SUP operator example"
        }
        context: {
          agent: "admin",
          ts: "...",
          source_suggestion: "sg_abc123",
          source_agent: "alice"
        }
   ```

**Tombstone** (spam):
```
NUL  suggestion:sg_abc123
     operand: { reason: "spam" }
     context: { agent: "admin", ts: "..." }
```

### 1.3 Provenance chain

The full audit trail for a merged suggestion:

```
eowiki_suggestions table:
  suggestion:sg_abc123
    ├─ rev:r_1  INS  agent_name="alice"    "Added SUP operator example"
    ├─ rev:r_2  INS  agent_name="alice"    "Fixed typo I introduced"
    ├─ SIG      agent="admin"              status → in_review
    ├─ rev:r_3  INS  agent="admin"         "Tightened intro paragraph"
    ├─ SIG      agent="admin"              status → approved
    └─ SIG      agent="admin"              status → merged, merged_as → r_15

eowiki table (canonical event log):
  wiki:operators/rev:r_15
    └─ INS  agent="admin"  source_suggestion="sg_abc123"  source_agent="alice"
           "Merged suggestion sg_abc123 by alice: Added SUP operator example"
```

Bidirectional links:
- Article revision `r_15` → `source_suggestion: "sg_abc123"` (in event ctx)
- Suggestion `sg_abc123` → `merged_as: "r_15"` (in SIG operand)

---

## 2. Public Submission Flow (No Auth Required)

### 2.1 Public submission form

New route on the public site: `/suggest/<slug>`

The form collects:

| Field | Required | Default |
|-------|----------|---------|
| Agent name | No | `"anonymous"` |
| Contact (email/handle) | No | — |
| Proposed content (markdown editor) | Yes | Pre-filled with current article content |
| Change summary | Yes | — |

Accessible from a **"Suggest Edit"** button on every published wiki/blog article.

### 2.2 Submission mechanics

1. Public site fetches current article content via existing public API
2. User edits in a simple markdown textarea (no TipTap — keep it lightweight)
3. On submit: `POST /eo_wiki_suggestions` with the INS event
4. Returns the suggestion ID → user sees confirmation with status link
5. Rate limiting: Xano function stack can check recent submissions by IP

### 2.3 Submission tracking

`/suggestion/<id>` — public read-only status page:
- Fetches events from `GET /eowiki_suggestions` filtered by `subject LIKE 'suggestion:<id>%'`
- Replays events client-side to show: status, revision history, admin notes (public ones)
- If merged: link to the resulting article revision

### 2.4 Edit token (optional)

On submission, generate a random token stored in the suggestion context. The confirmation page shows a URL like `/suggestion/<id>?token=<tok>`. With a valid token, the submitter can POST additional revision events to their own suggestion while status is `pending` or `in_review`.

---

## 3. Admin Review Flow (Auth Required)

### 3.1 Suggestion queue

New admin panel section: **Suggestions** (in admin sidebar)

- Fetches all events from `GET /eowiki_suggestions`
- Replays client-side to derive per-suggestion state (same replay pattern as existing content)
- Groups by status: `pending` → `in_review` → `approved` / `rejected` / `merged`
- Each card shows: target article, agent name, submitted date, summary, revision count

### 3.2 Review interface

When admin opens a suggestion:

1. **Side-by-side diff**: Current article (left) vs. proposed content (right)
   - Uses a simple line-diff algorithm on the markdown source
   - Additions in green, deletions in red
2. **Metadata panel**: agent name, contact, submission date, target article link, base revision
3. **Revision timeline**: All revisions of the suggestion, each showing author + timestamp + summary + diff from previous
4. **Action bar**:
   - **Start Review** → SIG status to `in_review`
   - **Edit** → Admin modifies content, creates new revision (INS) attributed to admin
   - **Approve** → SIG status to `approved`
   - **Merge** → Writes to real `eowiki` + `eowikicurrent`, SIG status to `merged`
   - **Reject** → SIG status to `rejected` with reason
   - **Delete (spam)** → NUL tombstone

### 3.3 Merge mechanics

When admin clicks **Merge**:

1. Take the latest revision content from the suggestion
2. Create a new `WikiRevision` on the target article using the existing `insRevision()` + `upsertCurrentRecord()` path
3. The revision's `summary` includes attribution: `"Merged suggestion sg_abc123 by alice: <original summary>"`
4. The event `ctx` includes `source_suggestion` and `source_agent` for provenance
5. SIG the suggestion as `merged` with `merged_as` pointing to the new revision ID
6. All writes go through the existing admin auth — the suggestion table is never touched by the main content pipeline

---

## 4. Why a Separate Table

| Concern | `eowikicurrent` approach | `eowiki_suggestions` approach |
|---------|--------------------------|-------------------------------|
| **Trust boundary** | Untrusted data mixed with canonical content | Clean separation — suggestions can't corrupt content |
| **Public write access** | Would need to expose `eowikicurrent` POST to public | Dedicated public endpoint, isolated table |
| **Query performance** | Suggestions pollute content queries | Admin fetches suggestions separately |
| **Cleanup** | Hard to purge spam without affecting content | Can truncate/purge suggestions table independently |
| **Event replay** | Suggestion events mixed into content replay | Separate replay — content projector ignores suggestions |
| **Merge = explicit bridge** | Implicit (already in the table) | Explicit act: admin writes to real tables on merge |

The separate table acts like a staging area / inbox. The merge is an explicit, audited bridge between the two worlds.

---

## 5. Edit History & Provenance Visibility

### 5.1 On articles (public)

The existing article history/X-Ray view is extended:
- Merged revisions show a badge: "Community contribution by alice"
- The `source_suggestion` in the event ctx links back to the suggestion
- Clicking through shows the full suggestion lifecycle

### 5.2 On suggestions (public status page)

`/suggestion/<id>` shows:
- Current status with timestamp
- All revisions (numbered), each showing author, timestamp, summary
- If merged: link to the resulting article + revision
- If rejected: admin's reason

### 5.3 On suggestions (admin view)

Full audit trail:
- All events (INS, SIG, ALT, NUL) with timestamps and agents
- IP of submission (in context, admin-only)
- Private admin notes
- Diff between any two revisions
- Link to target article's current content for comparison

---

## 6. New Components & Routes

### Public site (`/site/js/`)
- `suggest.js` — Submission form with markdown textarea, pre-filled from current article
- `suggestion-status.js` — Read-only suggestion status/history page
- Route: `/suggest/<slug>` → submission form
- Route: `/suggestion/<id>` → status page
- "Suggest Edit" button on wiki/blog article header

### Admin (`/admin/src/`)
- `editors/SuggestionQueue.tsx` — List/filter suggestions by status
- `editors/SuggestionReview.tsx` — Diff view, edit, approve/reject/merge
- `components/DiffView.tsx` — Inline markdown diff component
- `xano/suggestions.ts` — API client for `eowiki_suggestions` endpoints
- `eo/suggestions.ts` — Event constructors + replay for suggestion events
- New route in `App.tsx`: `/admin/suggestions`

### Xano (already created)
- `POST /eo_wiki_suggestions` — append suggestion event (public)
- `GET /eowiki_suggestions` — list all suggestion events (public, for admin + status pages)
- `GET /eowiki_suggestions/{id}` — single event by ID

---

## 7. Example User Journeys

### Journey A: Anonymous typo fix
1. Reader notices typo on `/wiki/operators`
2. Clicks "Suggest Edit" → `/suggest/operators`
3. Fixes the typo in the pre-filled markdown editor
4. Writes summary: "Fixed typo: 'recusion' → 'recursion'"
5. Leaves name blank → defaults to "anonymous"
6. POST to `/eo_wiki_suggestions` → gets suggestion ID `sg_7kx2`
7. Sees confirmation: "Suggestion submitted! Track status: /suggestion/sg_7kx2"
8. Admin sees new pending suggestion in queue
9. Opens it, sees the one-character diff, clicks **Merge**
10. `insRevision()` creates `wiki:operators/rev:r_12` with `source_suggestion: "sg_7kx2"`, `source_agent: "anonymous"`
11. Article publishes on next build cycle
12. Article history shows: "r_12 — Merged suggestion sg_7kx2 by anonymous: Fixed typo"

### Journey B: Named contribution with admin edits
1. "Alice" submits a rewrite of the Synthesis section with her name + email
2. Admin opens the suggestion, sees substantive changes in the diff
3. Clicks "Start Review" → SIG `in_review`
4. Admin edits two paragraphs → new revision r_2 (agent="admin")
5. Clicks "Merge" → INS `wiki:operators/rev:r_15` with source attribution
6. Article history: "r_15 — Merged suggestion sg_abc123 by alice"
7. Suggestion history: r_1 (alice), r_2 (admin edit), merged as r_15
8. Alice checks `/suggestion/sg_abc123` → sees full trail including admin's edits

---

## 8. Security Considerations

- **Isolation**: Suggestions never touch `eowikicurrent` or `eowiki` directly — only admin merge does
- **XSS prevention**: All submitted markdown is sanitized through the existing render pipeline before display
- **No file uploads**: Suggestions are text-only (markdown)
- **Rate limiting**: IP-based, enforced in Xano function stack on the POST endpoint
- **Admin-only merge**: No suggestion content reaches the public site without explicit admin action
- **IP logging**: Stored in event context for abuse tracking, visible only to admin
- **Token-based edit**: Submitters can only edit their own suggestion, only while pending/in_review
- **Spam cleanup**: NUL tombstone + ability to purge suggestions table without affecting content
