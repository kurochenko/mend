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

Mend passes marked inline findings, the marked summary, and diff references through the [[review.con:review-provider]] boundary. The adapter validates provider requirements, publishes the review, and returns provider-neutral references for persistence.
