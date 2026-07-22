---
type: feature
name: Replaceable Review Agent Harness
id: replaceable-review-agent-harness
links:
  - edge: includes
    target: 'review.term:review-agent-harness'
  - edge: includes
    target: 'review.con:review-agent-harness'
  - edge: includes
    target: 'review.flow:run-review-agent'
  - edge: includes
    target: 'review.inv:structured-review-output'
tags: []
context: review
---

Mend can select the MR review agent harness from project config while preserving the existing MR review workflow semantics. This enables Codex as a primary reviewer, keeps existing agent paths available, and lets tests exercise the flow with deterministic harness doubles.

This feature includes the [[review.term:review-agent-harness]] concept, the [[review.con:review-agent-harness]] boundary, the [[review.flow:run-review-agent]] behavior, and the [[review.inv:structured-review-output]] safety requirement.
