---
type: feature
name: Commit Push And Review Fix Batch
id: commit-push-and-review-fix-batch
context: review
links:
  - edge: includes
    target: review.term:fix-batch-request
  - edge: includes
    target: review.term:fixer-agent-result
  - edge: includes
    target: review.flow:commit-push-fix-batch
tags:
  - fix-loop
  - git
---

Mend can complete a successful [[review.term:fix-batch-request]] by using the [[review.term:fixer-agent-result]] to create one batch commit, push the MR source branch, and [[review.flow:commit-push-fix-batch]] into the standard review loop.
