---
type: feature
name: Queue Automatic Fix Batch
id: queue-automatic-fix-batch
context: review
links:
  - edge: includes
    target: review.term:review-finding
  - edge: includes
    target: review.term:fix-batch-request
  - edge: includes
    target: review.rule:automatic-fix-mode-gates
  - edge: includes
    target: review.flow:queue-automatic-fix-batch
tags:
  - automatic
  - fix-loop
---

Mend can [[review.flow:queue-automatic-fix-batch]] as a [[review.term:fix-batch-request]] for newly posted unresolved [[review.term:review-finding]] threads after review posting succeeds, when the project has explicitly enabled automatic fix mode and satisfies [[review.rule:automatic-fix-mode-gates]].
