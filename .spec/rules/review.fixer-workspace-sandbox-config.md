---
type: rule
name: Fixer Workspace Sandbox Config
id: fixer-workspace-sandbox-config
context: review
links:
  - edge: depends-on
    target: review.term:fixer-workspace
  - edge: constrains
    target: review.flow:prepare-fixer-workspace
tags:
  - fix-loop
  - workspace
---

The fixer workspace configuration constrains [[review.flow:prepare-fixer-workspace]] by controlling provider, image, network, explicit environment values, environment references, allowlisted host mounts, setup commands, and check commands. Mend must not mount host home directories or pass host environment values implicitly; only configured values enter the [[review.term:fixer-workspace]].
