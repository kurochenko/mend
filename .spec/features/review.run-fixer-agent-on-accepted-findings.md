---
type: feature
name: Run Fixer Agent On Accepted Findings
id: run-fixer-agent-on-accepted-findings
context: review
links:
  - edge: includes
    target: review.term:fix-batch-request
  - edge: includes
    target: review.term:fixer-workspace
  - edge: includes
    target: review.term:fixer-agent-result
  - edge: includes
    target: review.term:review-finding
  - edge: includes
    target: review.flow:run-fixer-agent
tags:
  - fix-loop
  - agent
---

Mend can [[review.flow:run-fixer-agent]] inside a prepared [[review.term:fixer-workspace]] to address only the accepted [[review.term:review-finding]] work items from a [[review.term:fix-batch-request]] and parse the resulting [[review.term:fixer-agent-result]].
