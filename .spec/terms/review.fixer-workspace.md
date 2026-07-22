---
type: term
name: Fixer Workspace
id: fixer-workspace
context: review
links:
  - edge: depends-on
    target: review.term:fix-batch-request
tags:
  - fix-loop
  - workspace
---

A fixer workspace is an isolated execution environment prepared for one [[review.term:fix-batch-request]]. It exposes the target merge request worktree to commands and agents, captures command results, and advertises whether Git commit and push are handled by the workspace provider or by Mend on the host.
