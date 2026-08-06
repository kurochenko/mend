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

The MR review flow selects the configured primary review harness, invokes it with the generated review prompt, retries file inspection once when required files were not inspected, parses the final structured review payload, and records harness diagnostics with the review output. The generated prompt directs reviewers to inspect relevant changed files and report only release- or development-blocking defects with a realistic intended-use trigger, a concrete material consequence, and a proportionate remedy. This eligibility gate applies to every finding category. Transient inconsistencies, speculative edge cases, generic best-practice gaps, and theoretical performance, reliability, concurrency, or scalability concerns are omitted unless an actual dependency contract requires a safeguard or ordinary usage makes the failure likely and material. After parsing, Mend removes suggestion-severity findings and comments plus recommended or optional findings before provider posting. Before provider posting, Mend replaces the model summary with a deterministic summary derived only from retained blocking defects and unresolved prior blockers. Every retained required finding, including a material performance finding, forces a request-changes assessment.

For update reviews, Mend reconstructs every tracked finding thread across the MR lifecycle and gives each one a collision-free typed identity derived from its provider thread identity. Finding and inline identities occupy separate namespaces, and repeated inline comments on the same file and line remain distinct when they belong to distinct provider threads. The generated output schema and its examples require one of these exact typed identities in every resolution verdict. Only open required blockers participate in resolution gating. Every expected blocker must have exactly one conservative normalized verdict before approval: fixed permits resolution, while missing, not-fixed, partially fixed, indeterminate, or conflicting duplicate verdicts keep the review blocked. Ensemble review passes the expected typed identity set through its internal policy normalization so valid verdicts survive unchanged to the outer review pipeline. Verdicts for unknown, resolved, optional, or recommended history are removed before provider posting. A provider thread that is reopened becomes an expected blocker again. For provider threads that cannot represent resolution, including GitHub general-comment pseudo-threads, a persisted fixed or resolved finding state prevents the blocker from gating later updates.

### Blocker lifecycle scenario matrix

| Scenario | Required behavior |
| --- | --- |
| No history | No prior verdict is required; unknown verdicts are discarded and cannot affect assessment or posting. |
| New required blocker | A retained required finding or inline comment forces request changes. |
| Fixed verdict | One fixed verdict for every expected open blocker permits approval when no new blocker exists and is the only prior verdict eligible for provider posting. |
| Not-fixed, partial, or indeterminate verdict | The matching blocker remains unresolved and forces request changes. |
| Missing verdict | Any expected open blocker without a verdict forces request changes. |
| Unknown verdict | The verdict is discarded before assessment output reaches provider posting. |
| Multiple updates | An unresolved tracked required blocker remains expected across every later update until its provider thread is resolved. |
| Duplicate verdicts | Conflicting verdicts for one identity normalize conservatively and cannot resolve the blocker. |
| Repeated same-line inline comments | Distinct provider threads have distinct typed identities and each requires its own verdict. |
| Resolved history | A resolved provider thread does not gate and verdicts targeting it are discarded. |
| Reopened history | A provider thread that becomes open again gates the next update. |
| Optional or recommended history | Historical findings without required actionability never gate and their verdicts are discarded. |
| Provider posting | Only normalized verdicts for expected open required blockers can produce provider replies or thread resolution. |
| Ensemble integration | Ensemble normalization preserves matching typed verdicts for the outer pipeline and cannot erase them by applying an empty expected set. |
| Generated schema | The JSON schema requires `finding:<provider-thread-id>` or `inline:<provider-thread-id>` rather than an untyped example identifier. |
| Fixed GitHub pseudo-thread | The fixed verdict persists local finding resolution through the provider-reply path; the non-resolvable `note_` provider thread remains open and is not counted as provider-resolved, while later updates do not re-gate it. |

Harnesses that can disable tools retry invalid final JSON once without tools. Harnesses that cannot disable tools fail invalid final JSON instead of launching a second tool-enabled review. Optional comparison harness execution may run alongside the primary harness and is recorded separately.

The flow depends on [[review.con:review-agent-harness]].
