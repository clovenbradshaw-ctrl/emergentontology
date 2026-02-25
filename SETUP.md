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

## Security Model

Write access is enforced by **Matrix room power levels** — no client-side trust required.

| Setting | Value | Effect |
|---|---|---|
| `join_rule` | `invite` | Random accounts can't join rooms |
| `history_visibility` | `world_readable` | Projector reads events without a token |
| `events_default` | `50` | Power 50+ required to send any event |
| `eo.op` event | `50` | Same — only moderators+ can write content |
| Your account | `100` | Admin — full control |
| Invited editors | `50` | Can write; cannot change room settings |

The server enforces power levels. Even if someone logs into the admin UI, their write attempts will be rejected by the homeserver if they lack sufficient power level.

### Initial setup

Run once with your admin token to create rooms with the correct security settings:

```sh
MATRIX_ACCESS_TOKEN=<your_token> \
MATRIX_USER_ID=@you:hyphae.social \
npx tsx tools/setup-rooms.ts
```

Get your access token from Element → Settings → Help & About → Access Token.

### Invite an editor

```sh
MATRIX_ACCESS_TOKEN=<your_token> \
MATRIX_USER_ID=@you:hyphae.social \
npx tsx tools/setup-rooms.ts --invite !roomid:hyphae.social @editor:hyphae.social 50
```

### Secure an existing room

```sh
MATRIX_ACCESS_TOKEN=<your_token> \
MATRIX_USER_ID=@you:hyphae.social \
npx tsx tools/setup-rooms.ts --secure-existing !roomid:hyphae.social
```

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
