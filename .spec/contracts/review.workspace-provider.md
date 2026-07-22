---
type: contract
name: Workspace Provider
id: workspace-provider
context: review
links:
  - edge: maps-to
    target: review.term:fixer-workspace
tags:
  - fix-loop
  - workspace
---

A workspace provider prepares, executes commands in, and tears down a [[review.term:fixer-workspace]]. Provider implementations may use local Docker containers, remote sandboxes, or future hosted workspaces, but they must return command outputs with configured secrets masked.
