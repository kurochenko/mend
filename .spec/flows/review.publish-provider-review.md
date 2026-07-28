---
type: flow
name: Publish Provider Review
id: publish-provider-review
context: review
links:
  - edge: depends-on
    target: review.con:review-provider
tags:
  - provider
  - publishing
---

Mend resolves each finding's file-line evidence against the current diff. A finding with at least one valid changed-line anchor is published once at its first valid anchor as a native inline thread; a finding with no valid anchor uses a general discussion fallback. Mend passes the marked inline findings, marked fallback findings, the marked summary, and diff references through the [[review.con:review-provider]] boundary. The adapter validates provider requirements, publishes the review, and returns provider-neutral references for persistence.
