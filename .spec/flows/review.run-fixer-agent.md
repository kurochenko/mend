---
type: flow
name: Run Fixer Agent
id: run-fixer-agent
context: review
links:
  - edge: depends-on
    target: review.term:fix-batch-request
  - edge: depends-on
    target: review.term:fixer-workspace
  - edge: depends-on
    target: review.term:fixer-agent-result
  - edge: depends-on
    target: review.term:review-finding
tags:
  - fix-loop
  - agent
---

When Mend runs a fixer agent, it sends only accepted [[review.term:review-finding]] records from the [[review.term:fix-batch-request]] as work items inside the prepared [[review.term:fixer-workspace]]. Rejected, deferred, and pending findings are included as context only. The agent must run configured checks and return a [[review.term:fixer-agent-result]].
