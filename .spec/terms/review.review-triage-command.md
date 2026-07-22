---
type: term
name: Review Triage Command
id: review-triage-command
links:
  - edge: depends-on
    target: 'review.term:review-finding'
tags:
  - fix-loop
  - human-gate
context: review
---

A review triage command is a human-authored `@mend` instruction in a GitLab merge request note that asks Mend to accept, reject, defer, or later fix accepted [[review.term:review-finding]] records.
