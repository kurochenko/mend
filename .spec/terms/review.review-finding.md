---
type: term
name: Review Finding
id: review-finding
links: []
tags:
  - fix-loop
context: review
---

A review finding is a Mend-owned actionable issue posted to a change request. When its evidence resolves to a changed line, it is a native inline provider thread and is resolvable where the provider supports resolution. Otherwise it is posted through the provider's general discussion fallback. It records the project, change request, review run, provider thread and message identifiers, lifecycle state, and optional human decision metadata needed for later batch fixing.
