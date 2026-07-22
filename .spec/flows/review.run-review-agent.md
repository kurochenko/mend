---
type: flow
name: Run Review Agent
id: run-review-agent
links:
  - edge: depends-on
    target: 'review.con:review-agent-harness'
tags: []
context: review
---

The MR review flow selects the configured primary review harness, invokes it with the generated review prompt, retries file inspection once when required files were not inspected, parses the final structured review payload, and records harness diagnostics with the review output. The generated prompt directs reviewers to inspect relevant changed files, trace meaningful call graph and dependency direction across changed symbols or modules, and report material newly introduced cycles or dependency direction inversions as architecture findings. Harnesses that can disable tools retry invalid final JSON once without tools. Harnesses that cannot disable tools fail invalid final JSON instead of launching a second tool-enabled review. Optional comparison harness execution may run alongside the primary harness and is recorded separately.

The flow depends on [[review.con:review-agent-harness]].
