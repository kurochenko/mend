---
type: feature
name: Persist Review Finding State
id: persist-review-finding-state
links:
  - edge: includes
    target: 'review.term:review-finding'
  - edge: includes
    target: 'review.flow:persist-review-finding-state'
  - edge: includes
    target: 'review.inv:review-finding-thread-identity'
tags:
  - fix-loop
  - db
context: review
---

Mend can persist each Mend-owned change-request review finding after it is posted or discovered so later human triage and fixer workflows can address the same provider thread deterministically.

This feature includes the [[review.term:review-finding]] concept, the [[review.flow:persist-review-finding-state]] behavior, and the [[review.inv:review-finding-thread-identity]] safety requirement.
