---
type: feature
name: Apply Finding Triage Command
id: apply-finding-triage-command
links:
  - edge: includes
    target: 'review.term:review-triage-command'
  - edge: includes
    target: 'review.term:review-finding'
  - edge: includes
    target: 'review.rule:triage-command-reasons'
  - edge: includes
    target: 'review.flow:apply-finding-triage-command'
tags:
  - fix-loop
  - human-gate
context: review
---

Mend can recognize explicit human triage commands in GitLab MR notes and apply them to persisted review findings without starting code changes.

This feature includes the [[review.term:review-triage-command]] concept, the [[review.term:review-finding]] target state, the [[review.rule:triage-command-reasons]] policy, and the [[review.flow:apply-finding-triage-command]] behavior.
