---
type: term
name: Fixer Agent Result
id: fixer-agent-result
context: review
links:
  - edge: depends-on
    target: review.term:review-finding
tags:
  - fix-loop
  - agent
---

A fixer agent result is the structured output from a fixer run. It records which accepted [[review.term:review-finding]] records were fixed, which could not be fixed with reasons, which files changed, which checks the agent ran, and any errors the agent reported.
