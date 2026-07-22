---
type: flow
name: Prepare Fixer Workspace
id: prepare-fixer-workspace
context: review
links:
  - edge: depends-on
    target: review.term:fixer-workspace
  - edge: depends-on
    target: review.con:workspace-provider
tags:
  - fix-loop
  - workspace
---

When a fix batch is ready to run, Mend creates or receives a merge request worktree, selects the configured [[review.con:workspace-provider]], prepares one [[review.term:fixer-workspace]], runs deterministic setup commands before agent work, allows agent and check commands to run in that workspace, records masked logs, and tears the workspace down at the end of the attempt.
