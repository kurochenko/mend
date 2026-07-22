---
type: flow
name: Queue Automatic Fix Batch
id: queue-automatic-fix-batch
context: review
links:
  - edge: depends-on
    target: review.term:review-finding
  - edge: depends-on
    target: review.term:fix-batch-request
tags:
  - automatic
  - fix-loop
  - queue
---

After a review has successfully posted Mend-owned resolvable finding threads and refreshed their [[review.term:review-finding]] records, Mend can queue one automatic [[review.term:fix-batch-request]] containing unresolved pending or accepted finding identities. The flow preserves existing human decisions by excluding rejected, deferred, fixed, not-fixed, and resolved findings, and it does not queue a new request when another fix batch is pending or running.
