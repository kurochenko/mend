---
type: contract
name: Review Provider Contract
id: review-provider
links:
  - edge: maps-to
    target: 'review.term:review-provider'
tags: []
context: review
---

Mend sends a change-request number plus operation-specific inputs (note bodies, thread ids, reaction names, or a publish batch of line-anchored drafts, summary body, diff refs, and draft-classification callbacks) to the provider adapter. The adapter returns provider-neutral shapes: change-request details including source repository identity when available, diff refs (start SHA optional; absent on GitHub), notes, threads with string ids and normalized positions, a resolution result that states whether the provider actually resolved the thread, and a publish result with draft-recovery counts and the summary note id.

Failure modes: API errors surface as typed errors carrying HTTP status and method; the publish operation must refuse to proceed when pre-existing drafts not belonging to the current run are found (GitLab draft notes, GitHub pending review comments). Adapters own all provider wire details — draft-note choreography and bulk publish on GitLab, single pending-review-safe review submission plus issue-comment summary on GitHub, thread resolution via GraphQL on GitHub. GitHub review-thread positions come from `PullRequestReviewThread`; general GitHub PR comments are non-resolvable pseudo-threads, so resolution returns false and local thread state remains unresolved even when the separate persisted finding state records a fixed verdict.

This contract maps to [[review.term:review-provider]].
