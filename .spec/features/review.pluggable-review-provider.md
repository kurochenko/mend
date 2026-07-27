---
type: feature
name: Pluggable Review Provider
id: pluggable-review-provider
links:
  - edge: includes
    target: 'review.term:review-provider'
  - edge: includes
    target: 'review.con:review-provider'
  - edge: includes
    target: 'review.flow:normalize-provider-webhook'
  - edge: includes
    target: 'review.flow:publish-provider-review'
  - edge: includes
    target: 'review.inv:provider-draft-ownership'
tags: []
context: review
---

Mend can review changes on GitLab or GitHub with the same workflow semantics, selected per project through the `platform` config field. The [[review.flow:normalize-provider-webhook]] flow converts provider events into shared internal events, while [[review.flow:publish-provider-review]] posts review output through the provider-neutral port and respects [[review.inv:provider-draft-ownership]].

This feature includes the [[review.term:review-provider]] concept and the [[review.con:review-provider]] boundary.
