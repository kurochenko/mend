---
type: flow
name: Normalize Provider Webhook
id: normalize-provider-webhook
context: review
links:
  - edge: depends-on
    target: review.con:review-provider
tags:
  - provider
  - webhook
---

Mend authenticates an incoming provider webhook, validates the supported payload, matches repository identity using the provider's case rules, and converts it into the shared review or note event consumed by the queue and conversation handlers. The [[review.con:review-provider]] boundary supplies provider-specific identity and thread lookup only after self-authored note events have been discarded.
