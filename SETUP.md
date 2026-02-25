# Emergent Ontology — GitHub Pages Setup

Event-sourced CMS backed by Matrix. All content stored as append-only `eo.op` events.
Public site served as static HTML. Admin editor writes to Matrix via browser login.

## Quick Start

No secrets required for the public build — the homeserver is hardcoded to `hyphae.social`.

### 1. GitHub Secrets (optional)

In your repo → Settings → Secrets → Actions, add only if needed:

| Secret | Required | Description |
|---|---|---|
| `MATRIX_ACCESS_TOKEN` | No | Token for including draft/private rooms in builds |
| `SITE_BASE_URL` | No | GitHub Pages URL, e.g. `https://user.github.io/repo` |

### 2. Set up Matrix rooms on hyphae.social

Create rooms with these canonical aliases:

```
#site:index:hyphae.social        ← navigation + routing index
#page:<slug>:hyphae.social       ← flat pages
#blog:<slug>:hyphae.social       ← blog posts
#wiki:<slug>:hyphae.social       ← wiki pages
#exp:<id>:hyphae.social          ← experiments
```

Rooms can be public (no token needed for builds) or private (requires `MATRIX_ACCESS_TOKEN`).

### 3. Enable GitHub Pages

Repo Settings → Pages → Source: **GitHub Actions**

### 4. Trigger a build

Actions tab → "Build & Deploy EO Site" → Run workflow.

Subsequent builds run automatically every 5 minutes (configurable in `build.yml`).

---

## Architecture

```
Matrix rooms (append-only eo.op events)
        ↓
  projector (replay)
        ↓
public/generated/state/*.json   ← current state snapshots
        ↓
  Astro SSG build
        ↓
  site/dist/                    ← static HTML
        ↓
  GitHub Pages
```

**Two stores, always in sync:**
- **Matrix**: canonical truth. Events are never overwritten.
- **`state/*.json`**: derived snapshots. Overwritten on every build (fast load).

The public site loads snapshots instantly.
`live-sync.js` fetches only delta events since the snapshot and shows an update banner if content changed.

---

## Event Schema

All operations use a single canonical shape:

```json
{
  "op": "INS|DES|ALT|SEG|CON|SYN|SUP|REC|NUL",
  "target": "wiki:operators/rev:r_10",
  "operand": { "...": "op-specific data" },
  "ctx": { "agent": "@alice:example.com", "ts": "2026-02-25T00:00:00Z" }
}
```

Matrix event type: `eo.op`

---

## Multiple Editors

Any Matrix user with room write permissions can use the admin editor.
Invite editors to rooms via your Matrix client (e.g., Element).
All edits are attributed to the editor's Matrix user ID in the event `ctx.agent`.

---

## Transparency Mode (X-Ray)

Press **Ctrl+Shift+X** (or **Cmd+Shift+X**) on any page to toggle X-Ray mode.
This overlays each content element with its `op(target, operand)` annotation
and shows the event stream in a side panel.

The X-ray ⊡ button is visible in the bottom-left corner of every page.

---

## Choreo Runtime

See [Choreo](https://github.com/clovenbradshaw-ctrl/Choreo) for the EO operator runtime
that the projector and admin editor are built against.
