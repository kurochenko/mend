---
type: rule
name: Triage Command Reasons
id: triage-command-reasons
links:
  - edge: constrains
    target: 'review.flow:apply-finding-triage-command'
tags:
  - fix-loop
  - human-gate
context: review
---

The [[review.flow:apply-finding-triage-command]] flow accepts `reject` commands without an explicit reason by using a default human rejection reason, but `defer` commands require a human-provided reason before a finding can move to deferred.
