---
type: flow
name: Persist Review Finding State
id: persist-review-finding-state
links:
  - edge: depends-on
    target: 'review.term:review-finding'
tags:
  - fix-loop
  - db
context: review
---

When Mend has a posted or discovered provider thread for a Mend-owned finding, it stores or refreshes the corresponding [[review.term:review-finding]] record using the provider thread identity. The stored record can be queried by project, change request, or provider thread and can move through the states pending, accepted, rejected, deferred, fixed, not fixed, and resolved as later workflows process it.

Persisting the state is constrained by the review finding thread identity invariant.
