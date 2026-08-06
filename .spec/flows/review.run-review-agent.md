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

The MR review flow selects the configured primary review harness, invokes it with the generated review prompt, retries file inspection once when required files were not inspected, parses the final structured review payload, and records harness diagnostics with the review output. The generated prompt directs reviewers to inspect relevant changed files and report only release- or development-blocking defects with a realistic intended-use trigger, a concrete material consequence, and a proportionate remedy. This eligibility gate applies to every finding category. Transient inconsistencies, speculative edge cases, generic best-practice gaps, and theoretical performance, reliability, concurrency, or scalability concerns are omitted unless an actual dependency contract requires a safeguard or ordinary usage makes the failure likely and material. After parsing, Mend removes suggestion-severity findings and comments plus recommended or optional findings before provider posting. Before provider posting, Mend replaces the model summary with a deterministic summary derived only from retained blocking defects and unresolved prior blockers. Every retained required finding, including a material performance finding, forces a request-changes assessment. For update reviews, only open blockers tracked in the reconstructed previous-review context participate in resolution gating. Every expected blocker must have a matching fixed verdict before approval; missing, not-fixed, partially fixed, or indeterminate verdicts keep the review blocked, while verdicts for unknown or already resolved identifiers do not affect assessment. Harnesses that can disable tools retry invalid final JSON once without tools. Harnesses that cannot disable tools fail invalid final JSON instead of launching a second tool-enabled review. Optional comparison harness execution may run alongside the primary harness and is recorded separately.

The flow depends on [[review.con:review-agent-harness]].
