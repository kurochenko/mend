---
type: feature
name: Queue Accepted Finding Fix Batch
id: queue-accepted-finding-fix-batch
links:
  - edge: includes
    target: 'review.term:fix-batch-request'
  - edge: includes
    target: 'review.term:review-finding'
  - edge: includes
    target: 'review.rule:accepted-fix-batch-gates'
  - edge: includes
    target: 'review.inv:single-active-mr-workflow'
  - edge: includes
    target: 'review.flow:queue-accepted-finding-fix-batch'
tags:
  - fix-loop
  - queue
context: review
---

Mend can turn a human fix-accepted command into one MR-level queued request for all currently accepted findings without starting the fixer agent in the same step.

This feature includes the [[review.term:fix-batch-request]] concept, the [[review.term:review-finding]] inputs, the [[review.rule:accepted-fix-batch-gates]] policy, the [[review.inv:single-active-mr-workflow]] invariant, and the [[review.flow:queue-accepted-finding-fix-batch]] behavior.
