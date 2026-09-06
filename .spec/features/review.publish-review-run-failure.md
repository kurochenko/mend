---
type: feature
name: Publish Review Run Failure
id: publish-review-run-failure
links:
  - edge: includes
    target: 'review.term:review-run-failure'
  - edge: includes
    target: 'review.flow:publish-review-run-failure'
tags:
  - diagnostics
context: review
---

Mend preserves actionable diagnostics when a review run fails after the agent has completed a step. The queue publishes a safe phase and category, identifies publication failures explicitly, and includes the failed run id for operator investigation while keeping internal provider and execution messages private.

This feature includes the [[review.term:review-run-failure]] concept and the [[review.flow:publish-review-run-failure]] flow.
