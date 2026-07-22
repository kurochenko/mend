# ADR 0002: Persist GitLab inline thread identity for resolution tracking

## Status

Proposed

## Date

2026-03-07

## Context

Update reviews can emit `resolutionVerdicts` for inline comments from the previous run. To reply to or resolve the old GitLab thread, Mend currently rebuilds the previous inline comments from the stored run result, lists current MR discussions, and tries to match each old inline comment back to a GitLab discussion by:

- file
- line
- hash of the formatted inline comment body embedded in the note marker

This is brittle.

Observed failure: a production MR note was correctly recognized in the update review as addressed, but Mend did not reply to or resolve the original thread. The update summary said the issue was addressed, while thread resolution reported `1 unmatched`.

Root cause:

- the original inline note included a GitLab suggestion block
- the stored run result kept `body`, `file`, `line`, and `severity`, but not `suggestion`
- previous-context reconstruction recomputed the body hash from an incomplete comment payload
- the recomputed hash no longer matched the marker stored in the original GitLab note
- Mend could not recover the `discussionId`, so the resolution verdict could not target the original thread

This class of failure is broader than the specific `suggestion` omission. Any future change in formatting, marker strategy, or reconstruction logic can break thread matching even when the review logic itself is correct.

## Decision

Persist GitLab thread identity in the database when inline comments are published, and use those persisted records as the source of truth for future thread resolution.

Do not rely on re-matching old GitLab notes from reconstructed text as the primary mechanism.

## Proposed Design

### New persisted record

Add a table for published inline comment records, for example `review_inline_threads`, with one row per published Mend inline comment.

Suggested fields:

- `id`
- `reviewRunId` - foreign key to `review_runs.id`
- `projectKey`
- `mrIid`
- `findingId` - the run-local inline identifier used by resolution verdicts, currently `file:line`
- `file`
- `line`
- `severity`
- `body`
- `suggestion` - nullable
- `bodyHash`
- `gitlabNoteId`
- `gitlabDiscussionId`
- `createdAt`

Optional fields if we want richer audit/debug support later:

- `resolvedAt`
- `supersededByRunId`
- `gitlabDiscussionResolved`

### Write path

After draft notes are bulk-published in the post step:

1. list Mend discussions/notes for the current run using the existing run markers
2. map each published inline comment to its GitLab `noteId` and `discussionId`
3. store one `review_inline_threads` row per published inline comment

The current marker-based scan is still useful here, but only once, immediately after posting, when the note body is still fresh and unambiguous.

### Read path for update reviews

When resolving previous comments in an update review:

1. load the previous run's inline thread records from the database
2. map `resolutionVerdict.previousFindingId` to the persisted row
3. use `gitlabDiscussionId` directly for reply/resolve operations
4. only fall back to best-effort discussion re-matching when no persisted row exists

This makes thread resolution independent from comment-body reconstruction.

## Immediate Mitigation

As a short-term bug fix, preserve `suggestion` in previous inline comment reconstruction so the current hash-based matcher can recover the existing discussions more reliably.

That fix is worth doing, but it should remain a compatibility fallback, not the long-term design.

## Consequences

- Thread resolution becomes stable across formatting changes and schema evolution.
- Inline comments with suggestion blocks no longer depend on lossy reconstruction.
- Mend can audit exactly which GitLab thread belongs to which review run.
- Debugging unmatched verdicts becomes much easier because the missing identity is visible in the database.
- Existing runs without persisted inline thread rows can still use the old matcher as a fallback during migration.

## Why this is the proper fix

The problem is identity, not review reasoning.

Mend already knew which previous inline concern was fixed or partially fixed. What it lacked was a durable pointer to the exact GitLab thread created earlier. Persisting `gitlabDiscussionId` and `gitlabNoteId` at publish time gives Mend a stable identity record and removes a whole category of text-matching bugs.
