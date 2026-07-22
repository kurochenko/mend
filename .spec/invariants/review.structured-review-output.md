---
type: invariant
name: Structured Review Output
id: structured-review-output
links:
  - edge: constrains
    target: 'review.flow:run-review-agent'
tags: []
context: review
---

Every successful MR review agent run must produce a payload that validates against Mend's review output schema before the workflow can post review notes or mark the run completed.

This invariant constrains [[review.flow:run-review-agent]].
