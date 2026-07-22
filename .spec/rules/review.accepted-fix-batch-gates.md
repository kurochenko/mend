---
type: rule
name: Accepted Fix Batch Gates
id: accepted-fix-batch-gates
links:
  - edge: constrains
    target: 'review.flow:queue-accepted-finding-fix-batch'
tags:
  - fix-loop
  - queue
context: review
---

The [[review.flow:queue-accepted-finding-fix-batch]] flow refuses a request when there are no accepted findings. Pending findings block a plain fix-accepted request, while fix-accepted-anyway bypasses the pending-finding block.
