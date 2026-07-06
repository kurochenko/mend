---
type: feature
name: Pluggable Review Provider
id: pluggable-review-provider
links:
  - edge: includes
    target: 'review.term:review-provider'
  - edge: includes
    target: 'review.con:review-provider'
tags: []
context: review
---

Mend can review changes on GitLab or GitHub with the same workflow semantics, selected per project through the `platform` config field. Webhook routes normalize provider events into shared internal events; all review, queueing, posting, thread, and fix flows operate on the provider-neutral port so provider differences stay inside the adapters.

This feature includes the [[review.term:review-provider]] concept and the [[review.con:review-provider]] boundary.
