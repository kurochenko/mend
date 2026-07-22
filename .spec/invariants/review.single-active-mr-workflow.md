---
type: invariant
name: Single Active MR Workflow
id: single-active-mr-workflow
links:
  - edge: constrains
    target: 'review.flow:queue-accepted-finding-fix-batch'
tags:
  - fix-loop
  - queue
context: review
---

For one merge request, Mend must not start or queue conflicting state transitions concurrently. Review queue changes and fix batch requests use the same MR-level lock, and an already pending or running fix batch makes duplicate fix commands idempotent.

This invariant constrains [[review.flow:queue-accepted-finding-fix-batch]].
