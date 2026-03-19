# Where EO Improves Upon GitHub Merging

## The comparison

GitHub's PR model: fork → branch → diff → review → merge commit.
EO's suggestion model: propose → event trail → review → SYN bridge.

Both solve the same problem: an outside contributor suggests a change, an owner decides whether to accept it. But GitHub's model inherits git's assumptions — that change is about *text replacement* in *files*. EO's operators let us model what's actually happening at each stage.

---

## 1. Merge is a semantic operation, not a text splice

**GitHub**: A merge is a commit. It records *what* changed (the diff) and *who* approved it (the committer). The *type* of merge — whether it was a typo fix, a conceptual rewrite, a factual correction, a perspective addition — lives only in the commit message, unstructured prose that no system can act on.

**EO**: The merge is a `SYN` event with an explicit `mode`:

```
SYN  wiki:operators/rev:r_15
     operand: {
       mode: "proposal_merge",
       source_suggestion: "sg_abc123",
       source_agent: "alice",
       chosen: "r_3",
       inputs: ["r_10", "r_3"]   // base revision + final proposed revision
     }
```

The operation *is* the metadata. You can query: "show me all merges from outside contributors," "show me all merges where the admin edited before merging," "show me all merges to this article." These aren't searches through commit messages — they're structural queries on typed events.

**What this enables**: A dashboard that shows contribution patterns, merge frequency by article, which suggestions get edited before merge vs. merged as-is. GitHub can approximate this through API queries on PR metadata, but the semantics are bolted on (labels, templates) rather than intrinsic.

---

## 2. The review trail is the thing, not metadata about the thing

**GitHub**: The PR has two parallel tracks that never truly merge:
- The *code* track: commits, diffs, force-pushes (which destroy history)
- The *conversation* track: review comments, approvals, status checks

These live in different systems (git vs. GitHub's database). A review comment references a line of code at a point in time — but if the code changes, the comment floats, orphaned. The review *about* the change and the change *itself* are fundamentally separate objects.

**EO**: Review actions are events in the same log as content changes:

```
INS  sg_abc/rev:r_1   agent_name="alice"     "Initial submission"
INS  sg_abc/rev:r_2   agent_name="alice"     "Addressed feedback"
SIG  sg_abc            agent="admin"          status → in_review
INS  sg_abc/rev:r_3   agent="admin"          "Tightened intro"
SIG  sg_abc            agent="admin"          status → merged
```

The admin's edit to the suggestion content (rev:r_3) and the admin's decision to merge (SIG → merged) live in the same event stream. There's no gap between "reviewing" and "changing" — they're the same kind of thing. You replay the events and you see *exactly* what happened, in order, with no parallel track to reconcile.

**What this enables**: A submitter checking `/suggestion/sg_abc123` sees a single timeline: their submission, their revision, admin's edit, admin's merge. No need to cross-reference a "Conversation" tab with a "Files Changed" tab with a "Commits" tab.

---

## 3. Attribution survives the merge

**GitHub**: Three merge strategies, all lossy in different ways:
- **Merge commit**: Preserves branch history but the contributor's commits are buried in a merge commit authored by the maintainer
- **Squash merge**: Destroys all individual commits; contributor becomes a `Co-authored-by` trailer (if the maintainer remembers to add it)
- **Rebase merge**: Rewrites commit hashes; the contributor's commits appear as if the maintainer wrote them (authored-by vs. committed-by distinction is subtle and rarely surfaced in UIs)

In all three cases, the *decision* to merge is attributed to the maintainer. The contributor's identity is secondary — a commit message convention, not a structural property.

**EO**: Attribution is structural and bidirectional:
- The merged revision on the article carries `source_suggestion: "sg_abc123"` and `source_agent: "alice"` in its event context — not in a commit message, in the data
- The suggestion carries `merged_as: "r_15"` — it knows where it landed
- The `agent_name` field (defaulting to "anonymous") is a first-class property of the event, not a trailer

**What this enables**:
- Article page can show "This section includes contributions from alice" — derived from event data, not manual attribution
- X-Ray mode on a paragraph can show its full lineage: "Originally by admin, revised via suggestion sg_abc123 by alice, edited by admin before merge"
- A contributor's history page can list all their merged suggestions without scraping commit messages

---

## 4. Rejection is a first-class event, not an absence

**GitHub**: A closed-without-merging PR is... a closed PR. The *reason* lives in a comment (if the maintainer bothered). There's no structured distinction between "rejected: out of scope," "rejected: factually wrong," "rejected: duplicate," and "closed by bot: stale." GitHub's API has `merged: false` and that's it.

**EO**: Rejection is a SIG event with structured data:

```
SIG  sg_abc
     operand: { set: { status: "rejected", reason: "Factual error in section 3" } }
     context: { agent: "admin", ts: "..." }
```

And tombstoning spam is a different operator entirely:

```
NUL  sg_abc
     operand: { reason: "spam" }
```

These are semantically distinct operations. You can count rejections by reason. You can distinguish "this was considered and declined" (SIG → rejected) from "this was never legitimate" (NUL). GitHub collapses both into "closed."

**What this enables**: A public-facing transparency page showing: "12 suggestions received, 8 merged, 3 rejected (2 out of scope, 1 factual error), 1 spam." The reasons are queryable, not buried in comment threads.

---

## 5. The diff is between revisions, not file snapshots

**GitHub**: Diffs operate on *files*. A PR diff shows you what lines changed. But articles aren't files — they're semantic objects with structure (title, sections, body, metadata). GitHub can't show you "the title changed" vs. "a paragraph in section 3 was reworded" — it shows you line 4 changed and lines 27-31 changed.

**EO**: Suggestions reference specific *revisions* of specific *content entities*:

```
target_content_id: "wiki:operators"
target_revision_id: "r_10"          // "I forked from this"
```

The diff is between the proposed content and the base revision — not between two file snapshots in a tree. When the admin reviews, they see the semantic context: "This suggestion modifies the Operators article, branching from revision r_10. The article is currently on r_12 (2 revisions ahead)."

**What this enables**:
- Detecting staleness: "This suggestion was based on r_10 but the article has moved to r_12 — admin should check if the changes still apply"
- Targeted diffs: The system knows this is *article* content and can diff at the section/paragraph level rather than the line level
- Multiple suggestions against the same article can be compared against each other, not just against the current state

---

## 6. Edits on the PR itself have provenance

**GitHub**: When a contributor pushes new commits to a PR branch, the old state is preserved in the commit history. But when they *force-push* (common after rebase or amend), the previous state is destroyed. GitHub shows "force-pushed" in the timeline but the old code is gone. Review comments on disappeared code become orphans.

**EO**: Every revision of a suggestion is an append-only INS event:

```
INS  sg_abc/rev:r_1   "Initial submission"          by alice
INS  sg_abc/rev:r_2   "Addressed admin feedback"    by alice
INS  sg_abc/rev:r_3   "Admin: tightened intro"       by admin
```

Nothing is overwritten. r_1 still exists even after r_3. You can diff any two revisions. The admin can see "alice's original submission" alongside "what alice changed after feedback" alongside "what I (admin) changed before merging." Force-push doesn't exist as a concept — every state is preserved.

**What this enables**: Full audit trail of how a suggestion evolved during review. If the admin edited before merging, the original contributor's intent is still visible. If the contributor revised multiple times, each revision is independently diffable.

---

## 7. Superposition: holding competing suggestions without forced resolution

**GitHub**: If two PRs modify the same section, one must merge first; the second gets merge conflicts. There's no way to hold both proposals simultaneously and compare them before choosing. The first-to-merge wins by default.

**EO**: Multiple suggestions against the same article naturally coexist. The admin can:
1. View all pending suggestions for `wiki:operators` side by side
2. Choose to merge one, or merge parts of both (creating a new revision that synthesizes them)
3. The `SYN` event records the decision: `{mode: 'editorial_synthesis', inputs: ['sg_abc', 'sg_def']}`
4. Or use `SUP` to hold both as valid interpretations if they represent genuine perspectival differences

**What this enables**: An admin reviewing suggestions sees the full landscape of proposed changes, not a queue where order determines merge-ability. Competing suggestions are information, not conflicts.

---

## 8. Anonymous contribution without accounts

**GitHub**: Contributing requires a GitHub account. Even for a typo fix, the contributor must:
1. Have/create a GitHub account
2. Fork the repo
3. Create a branch
4. Make the edit
5. Open a PR

This is a massive friction barrier for drive-by corrections.

**EO**: The `agent_name` field defaults to "anonymous." No account, no fork, no branch. The submission form is:
1. Click "Suggest Edit"
2. Fix the typo
3. Optionally enter your name
4. Submit

The identity is self-declared, not authenticated — which is appropriate for the trust level. You're suggesting a change that an admin will review; your identity is informational, not a security boundary.

**What this enables**: Radically lower friction for small corrections. The suggestion system becomes more like a "report a typo" button than a PR workflow, while still maintaining full provenance and review mechanics for substantial contributions.

---

## Summary: What's structurally different

| Aspect | GitHub Merging | EO Suggestion Merging |
|--------|---------------|----------------------|
| Merge semantics | Opaque commit | Typed SYN event with mode |
| Review + change | Separate systems (comments vs. commits) | Same event stream |
| Attribution | Commit message conventions | Structural `source_agent` field |
| Rejection | Closed PR + optional comment | SIG with structured reason |
| Diff granularity | File lines | Content revisions |
| PR edit history | Destructible (force-push) | Append-only, all revisions preserved |
| Competing proposals | Merge conflicts | Coexisting suggestions, SUP/SYN |
| Contributor identity | Requires account | Optional, defaults to anonymous |
| Provenance | Reconstructed from git log | Intrinsic to every event |

The core insight: GitHub models merging as *text operations on files with social metadata bolted on*. EO models it as *semantic operations on content with provenance built in*. The suggestion system doesn't need to add attribution, review tracking, or decision logging as features — they fall out of the event architecture automatically.
