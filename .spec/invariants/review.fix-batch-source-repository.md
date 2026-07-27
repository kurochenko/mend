---
type: invariant
name: Fix Batch Source Repository
id: fix-batch-source-repository
context: review
links:
  - edge: constrains
    target: review.flow:commit-push-fix-batch
tags:
  - fix-loop
  - git
  - safety
---

The [[review.flow:commit-push-fix-batch]] flow may push only when the change request source branch belongs to the configured repository. Cross-repository source branches must be refused before a fixer workspace is created or any push is attempted.
