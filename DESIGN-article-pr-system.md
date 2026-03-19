# Article PR Submission System — Design

## Overview

A system allowing outside users to submit "pull requests" on articles (wiki, blog), which an admin can review, edit, and approve — with full provenance and edit history visible throughout.

The design fits naturally into the existing EO event-sourcing architecture: PRs are a new content type (`proposal`) backed by the same `eowiki` event log and `eowikicurrent` state table, using the existing EO operators (INS, SIG, ALT, SYN, NUL).

---

## 1. Data Model

### 1.1 New content type: `proposal`

A proposal is a first-class content entity stored in `eowikicurrent` with `record_id = "proposal:<uuid>"`.

```typescript
interface Proposal {
  proposal_id: string;           // "pr_" + nanoid
  target_content_id: string;     // e.g. "wiki:operators", "blog:first-post"
  target_revision_id: string;    // the revision the PR was branched from (base)

  // Submitter identity
  agent_name: string;            // display name — defaults to "anonymous"
  agent_contact?: string;        // optional email/handle for follow-up

  // The proposed content
  proposed_revision: {
    format: 'markdown' | 'html';
    content: string;             // full article body (the proposed new state)
    summary: string;             // submitter's description of the change
  };

  // Lifecycle
  status: 'pending' | 'in_review' | 'approved' | 'merged' | 'rejected' | 'withdrawn';
  submitted_at: string;          // ISO timestamp
  reviewed_at?: string;
  merged_at?: string;

  // Admin review
  admin_notes?: string;          // private admin notes
  admin_edited_revision?: {      // if admin edits the proposal before merging
    format: 'markdown' | 'html';
    content: string;
    summary: string;
  };

  // Edit history on the PR itself
  revisions: ProposalRevision[];
}

interface ProposalRevision {
  rev_id: string;
  agent: string;                 // who made this edit (submitter name or admin)
  content: string;
  summary: string;
  ts: string;
}
```

### 1.2 Event shapes

All proposal lifecycle events use standard EO operators:

| Action | Op | Target | Operand |
|--------|----|--------|---------|
| Submit PR | `INS` | `proposal:<id>/rev:r_1` | `{format, content, summary, agent_name, agent_contact?, target_content_id, target_revision_id}` |
| Submitter edits PR | `ALT` | `proposal:<id>/rev:r_N` | `{patch: [...], summary}` — or new `INS` revision |
| Admin starts review | `SIG` | `proposal:<id>` | `{set: {status: 'in_review'}}` |
| Admin edits PR | `ALT` | `proposal:<id>/rev:r_N` | `{patch: [...], summary: "admin edit: ..."}` |
| Admin approves | `SIG` | `proposal:<id>` | `{set: {status: 'approved'}}` |
| Admin merges | `SYN` | `<target_content_id>` | `{mode: 'proposal_merge', proposal_id, chosen: rev_id}` |
| Admin rejects | `SIG` | `proposal:<id>` | `{set: {status: 'rejected', admin_notes: "..."}}` |
| Submitter withdraws | `SIG` | `proposal:<id>` | `{set: {status: 'withdrawn'}}` |
| Tombstone | `NUL` | `proposal:<id>` | `{reason: 'spam'/'policy_violation'}` |

### 1.3 Provenance chain

Every event carries `ctx.agent` and `ctx.ts`. The provenance chain is:

```
proposal:pr_abc123 created by "alice" at 2026-03-19T10:00:00Z
  ├─ rev:r_1  INS  agent="alice"      "Initial submission"
  ├─ rev:r_2  INS  agent="alice"      "Fixed typo in section 3"
  ├─ SIG      agent="admin"           status → in_review
  ├─ rev:r_3  INS  agent="admin"      "Tightened intro paragraph"
  ├─ SIG      agent="admin"           status → approved
  └─ SYN on wiki:operators            merged rev:r_3, source=proposal:pr_abc123
```

This is fully visible in the existing X-Ray transparency mode and the history panel.

---

## 2. Public Submission Flow (No Auth Required)

### 2.1 Public submission form

A new route on the public site: `/propose/<content-type>/<slug>`

The form collects:

| Field | Required | Default |
|-------|----------|---------|
| Agent name | No | `"anonymous"` |
| Contact (email/handle) | No | — |
| Proposed content (markdown editor) | Yes | Pre-filled with current article content |
| Change summary | Yes | — |

The form is accessible from a "Suggest Edit" button on every published wiki/blog article.

### 2.2 Submission endpoint

A new **public Xano API endpoint** (no auth): `POST /submit_proposal`

```json
{
  "target_content_id": "wiki:operators",
  "target_revision_id": "r_10",
  "agent_name": "alice",
  "agent_contact": "alice@example.com",
  "proposed_content": "# Operators\n\nThe nine operators...",
  "format": "markdown",
  "summary": "Added missing example for SUP operator"
}
```

Server-side:
1. Validates `target_content_id` exists and is published
2. Rate-limits by IP (e.g., 5 submissions/hour)
3. Creates `proposal:<id>` in `eowikicurrent` with `status: 'pending'`, `visibility: 'private'`
4. Logs INS event to `eowiki` event log
5. Returns `{proposal_id, status: 'pending', submitted_at}`

### 2.3 Submission tracking

After submission, the user gets a **proposal ID** (e.g., `pr_abc123`). They can check status at `/proposal/<id>` (public, read-only view showing status and any admin notes marked as public).

Optionally: if they provided an email, they receive a **token link** allowing them to edit their proposal while it's still `pending` or `in_review`.

---

## 3. Admin Review Flow (Auth Required)

### 3.1 Proposal queue

New admin panel section: **Proposals** (accessible from the admin sidebar)

- Lists all proposals grouped by status: `pending` → `in_review` → `approved`
- Each card shows: target article, submitter name, submission date, change summary
- Sortable/filterable by target article, date, status

### 3.2 Review interface

When admin opens a proposal:

1. **Side-by-side diff view**: Current article content (left) vs. proposed content (right), with inline diffs highlighted
2. **Proposal metadata**: submitter name, contact, submission date, target article link
3. **Edit history timeline**: All revisions of the proposal, showing who edited what and when
4. **Action buttons**:
   - **Start Review** → sets status to `in_review`
   - **Edit Proposal** → admin can modify the proposed content (creates a new revision attributed to admin)
   - **Approve** → sets status to `approved`
   - **Merge** → creates a SYN event on the target article, incorporating the proposal as a new revision
   - **Reject** → sets status to `rejected` with required reason
   - **Request Changes** → adds admin notes visible to submitter (if they have a token)

### 3.3 Merge mechanics

When admin clicks **Merge**:

1. A new `WikiRevision` is created on the target article via `INS` on `<target>/rev:r_N`
   - `summary` includes: `"Merged from proposal pr_abc123 by alice"`
   - `ctx.agent` = admin
   - The operand includes `source_proposal: "proposal:pr_abc123"` for traceability
2. A `SYN` event is logged: `{mode: 'proposal_merge', proposal_id: 'pr_abc123', chosen: 'r_3'}`
3. The proposal status is updated to `merged` via `SIG`
4. The merged revision becomes the current revision of the target article

This creates a bidirectional provenance link:
- **Article history** shows: "Revision r_11 — Merged from proposal pr_abc123 by alice"
- **Proposal history** shows: "Merged into wiki:operators as revision r_11"

---

## 4. Edit History & Provenance Visibility

### 4.1 On articles (public)

The existing article history/X-Ray view is extended:
- Merged revisions show a badge: `📥 Community contribution by alice`
- Clicking the badge links to the proposal detail view
- The revision summary preserves the original submitter's description + admin notes

### 4.2 On proposals (public status page)

`/proposal/<id>` shows:
- Current status with timestamp
- Original submission content
- All revisions (numbered), each showing:
  - Author (submitter name or "admin")
  - Timestamp
  - Change summary
  - Diff from previous revision
- Admin notes (if any are marked public)
- If merged: link to the resulting article revision

### 4.3 On proposals (admin view)

Full audit trail including:
- All events (INS, SIG, ALT, SYN) with timestamps and agents
- IP address of submission (stored in ctx, visible only to admin)
- Private admin notes
- Diff between any two revisions

---

## 5. Architecture Decisions

### 5.1 Why proposals are first-class content entities

- Reuses the entire existing infrastructure: event log, replay, projector, X-Ray
- No new database tables needed — just new records in `eowikicurrent` + events in `eowiki`
- The projector can render proposal status pages as static JSON just like articles
- Proposals are naturally included in the admin editor's content management

### 5.2 Anonymous submission with optional identity

- `agent_name` defaults to `"anonymous"` — zero friction for drive-by corrections
- Named submissions build reputation over time (admin can see submission history by agent name)
- No account system needed — identity is a self-declared string, not authenticated
- Contact info is optional and stored only in the proposal's private context (not publicly visible)

### 5.3 Rate limiting and anti-abuse

- IP-based rate limiting on the Xano endpoint (configurable, default 5/hour)
- Proposals are `visibility: 'private'` by default — never shown on the public site until merged
- Admin can NUL-tombstone spam proposals
- Optional: simple CAPTCHA or proof-of-work challenge on the submission form

### 5.4 No real-time collaboration

- Proposals are async: submitter creates, admin reviews later
- No WebSocket/live-sync needed for proposals
- The existing 5-minute build cycle handles merged content publication

---

## 6. New Components & Routes

### Public site (`/site/js/`)
- `propose.js` — Submission form with markdown editor, pre-filled from current article
- `proposal-status.js` — Read-only proposal status page
- Route: `/propose/<type>/<slug>` → submission form
- Route: `/proposal/<id>` → status page
- "Suggest Edit" button added to wiki/blog article pages

### Admin (`/admin/src/`)
- `editors/ProposalQueue.tsx` — List/filter proposals by status
- `editors/ProposalReview.tsx` — Side-by-side diff, edit, approve/reject/merge
- `components/DiffView.tsx` — Inline diff component (line-by-line markdown diff)
- `eo/proposals.ts` — Event constructors for proposal lifecycle
- New route in `App.tsx`: `/admin/proposals`

### Xano
- New public endpoint: `POST /submit_proposal` (rate-limited, validates target exists)
- Existing endpoints handle everything else (proposals are just content records)

### Projector (`/tools/projector/`)
- `src/proposals.ts` — Replay logic for proposal events → projected state
- Renders proposal status JSON to `/site/generated/proposals/`

---

## 7. Example User Journeys

### Journey A: Anonymous typo fix
1. Reader notices typo on `/wiki/operators`
2. Clicks "Suggest Edit" → taken to `/propose/wiki/operators`
3. Fixes the typo in the pre-filled markdown editor
4. Writes summary: "Fixed typo: 'recusion' → 'recursion'"
5. Leaves name blank → defaults to "anonymous"
6. Submits → gets proposal ID `pr_7kx2`
7. Admin sees new pending proposal in queue
8. Opens it, sees the one-character diff, clicks **Merge**
9. Article is updated with next build cycle
10. Article history shows: "Revision r_12 — Merged from proposal pr_7kx2 by anonymous"

### Journey B: Substantive contribution with admin edits
1. "Alice" submits a rewrite of the Synthesis section with her name
2. Admin reviews, likes the direction but edits two paragraphs
3. Admin's edit creates revision r_2 on the proposal (attributed to admin)
4. Admin approves and merges
5. Article history shows the merge with Alice's name
6. Proposal history shows both Alice's original and admin's edit
7. Alice checks `/proposal/pr_abc123` and sees the full edit trail

---

## 8. Security Considerations

- **No auth for submissions**: Proposals are sandboxed (private, no direct site impact)
- **XSS prevention**: All submitted markdown is sanitized before rendering (existing render pipeline handles this)
- **No file uploads**: Proposals are text-only (markdown/HTML)
- **Rate limiting**: Prevents flooding
- **Admin-only merge**: No proposal content reaches the public site without explicit admin action
- **IP logging**: Stored in event ctx for abuse tracking, visible only to admin
