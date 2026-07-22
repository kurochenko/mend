---
type: feature
name: Configure Fixer Workspace Provider
id: configure-fixer-workspace-provider
context: review
links:
  - edge: includes
    target: review.term:fixer-workspace
  - edge: includes
    target: review.con:workspace-provider
  - edge: includes
    target: review.rule:fixer-workspace-sandbox-config
  - edge: includes
    target: review.flow:prepare-fixer-workspace
tags:
  - fix-loop
  - workspace
---

Mend can configure a provider-neutral [[review.term:fixer-workspace]] for future accepted-finding fix batches, with Docker as the first [[review.con:workspace-provider]] implementation. The configuration follows [[review.rule:fixer-workspace-sandbox-config]], and runtime preparation follows [[review.flow:prepare-fixer-workspace]].
