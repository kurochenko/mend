---
type: term
name: Fix Batch Request
id: fix-batch-request
links:
  - edge: depends-on
    target: 'review.term:review-finding'
tags:
  - fix-loop
  - queue
context: review
---

A fix batch request is a durable MR-level request to fix the currently accepted [[review.term:review-finding]] records as one batch after Mend has passed human gating.
