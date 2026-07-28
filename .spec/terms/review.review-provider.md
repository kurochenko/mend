---
type: term
name: Review Provider
id: review-provider
links: []
tags: []
context: review
---

A review provider is the git hosting platform adapter that Mend uses to read change-request state and publish review output. Each configured project selects exactly one provider via its `platform` config field (`gitlab` or `github`). A provider exposes change-request details, diff refs, changed files, standalone notes, threads with messages and normalized inline positions, reactions, and an intent-level review publish operation. Native inline threads are resolvable when the provider supports resolution; general discussion fallbacks may not be. GitLab and GitHub are projections of this concept: a GitLab merge request and a GitHub pull request are both the provider's change request, identified by a per-repository integer number.
