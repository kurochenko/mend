---
type: invariant
name: Review Finding Thread Identity
id: review-finding-thread-identity
links:
  - edge: constrains
    target: 'review.flow:persist-review-finding-state'
tags:
  - fix-loop
  - db
context: review
---

Every active persisted review finding maps to exactly one provider discussion identity, and persisting the same provider discussion again must update the existing record rather than creating a duplicate finding.

This invariant constrains [[review.flow:persist-review-finding-state]].
