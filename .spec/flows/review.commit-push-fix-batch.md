---
type: flow
name: Commit Push Fix Batch
id: commit-push-fix-batch
context: review
links:
  - edge: depends-on
    target: review.term:fix-batch-request
  - edge: depends-on
    target: review.term:fixer-agent-result
tags:
  - fix-loop
  - git
---

After a fixer agent produces a [[review.term:fixer-agent-result]], Mend commits the batch changes once, pushes only the merge request source branch, verifies the remote head matches the pushed commit, records the updated [[review.term:fix-batch-request]] result, and queues the standard MR review again.
