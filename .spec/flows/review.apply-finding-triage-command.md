---
type: flow
name: Apply Finding Triage Command
id: apply-finding-triage-command
links:
  - edge: depends-on
    target: 'review.term:review-triage-command'
  - edge: depends-on
    target: 'review.term:review-finding'
tags:
  - fix-loop
  - human-gate
context: review
---

When Mend receives a human GitLab MR note containing a [[review.term:review-triage-command]], it identifies the Mend-owned finding thread when one is available, updates the matching [[review.term:review-finding]] state for accept, reject, or defer commands, and completes note processing without invoking a fixer agent. Commands for non-Mend threads or threads without a persisted finding do not mutate finding state.

The command parser also recognizes the future fix-accepted command family, but this flow does not start code changes.
