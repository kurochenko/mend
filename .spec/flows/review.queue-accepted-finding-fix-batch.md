---
type: flow
name: Queue Accepted Finding Fix Batch
id: queue-accepted-finding-fix-batch
links:
  - edge: depends-on
    target: 'review.term:review-triage-command'
  - edge: depends-on
    target: 'review.term:fix-batch-request'
  - edge: depends-on
    target: 'review.term:review-finding'
tags:
  - fix-loop
  - queue
context: review
---

When Mend receives a fix-accepted [[review.term:review-triage-command]], it evaluates the current MR [[review.term:review-finding]] records, applies the accepted fix batch gates, and stores one pending [[review.term:fix-batch-request]] containing the accepted finding identities. If a review is already running, the request remains queued instead of starting work. If another fix batch is already pending or running, the command is treated as a duplicate and does not create another request.
