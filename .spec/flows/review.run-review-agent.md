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

The MR review flow selects the configured primary review harness, invokes it with the generated review prompt, retries file inspection once when required files were not inspected, parses the final structured review payload, and records harness diagnostics with the review output. The generated prompt directs reviewers to inspect relevant changed files and report only release- or development-blocking defects with a realistic intended-use trigger, a concrete material consequence, and a proportionate remedy. This eligibility gate applies to every finding category. Transient inconsistencies, speculative edge cases, generic best-practice gaps, and theoretical performance, reliability, concurrency, or scalability concerns are omitted unless an actual dependency contract requires a safeguard or ordinary usage makes the failure likely and material. Harnesses that can disable tools retry invalid final JSON once without tools. Harnesses that cannot disable tools fail invalid final JSON instead of launching a second tool-enabled review. Optional comparison harness execution may run alongside the primary harness and is recorded separately.

The flow depends on [[review.con:review-agent-harness]].
