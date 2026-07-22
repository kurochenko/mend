# Proposal: improvement miner — distilling review findings into implementer fixes

Status: Phase 1 in implementation
Date: 2026-07-07

## Summary

Mend sees every mistake implementers make, plus the human verdict on which were real (`review_findings.decision_reason`, triage states). This feature closes the loop: a periodic miner clusters the confirmed-finding corpus into recurring mistake classes and turns each into a typed improvement proposal for the *implementer* side — a lint/diff-police rule, an AGENTS.md/skill addendum, or a process change. Proposals are collected internally (never posted to MR comments), surfaced in the dashboard and a CLI, and accepted/dismissed by a human. Shipped proposals are tracked for recurrence so rules that work are proven and rules that stop mattering get retired.

Production motivation (7/4–7/7): a large share of the 88 findings were rule-following failures — sanitized-logging violations, raw provider errors surfaced to UI, missing regression tests, layering breaks — where the rule already existed in the repo's instructions but was not applied. Preventing a class at implementation time is strictly cheaper than catching it at review time, 12 cycles per MR.

## Design

### Data flow

```
review_findings (+ threads, decision reasons)      [exists]
        │  weekly digest, per project
        ▼
pattern miner — one LLM call: cluster + propose    [phase 1]
        │  extends existing open clusters (stable cluster_slug),
        │  proposes remediation typed tooling|instructions|process
        ▼
improvement_proposals table                        [phase 1]
        │
        ├─ dashboard /improvements + CLI accept/dismiss   [phase 1]
        ├─ accepted → human implements (or bot MR)        [phase 2]
        └─ recurrence tracking per shipped cluster        [phase 3]
```

### Proposal types, preference order

1. **tooling** — deterministic guard expressible as a `scripts/review.ts` diff-police regex, an eslint/biome rule, or a dependency-cruiser rule in the target repo. Always preferred: kills the class permanently, zero prompt budget, cannot be ignored.
2. **instructions** — concrete addendum for the repo's AGENTS.md or a specific skill file, with proposed wording and evidence attached.
3. **process** — workflow changes (pre-push self-review, test scaffolds).

### Cluster stability

Clusters carry a stable `cluster_slug`. Each digest run receives the open clusters as context and must extend them (bump occurrence count, add evidence) rather than re-invent; only genuinely new classes create new slugs.

### Rules

- Never post to MR comments. Internal collection only.
- Instruction/tooling changes always require human accept (they alter every future implementer run).
- Miner LLM harness/model is config (`improvements.agent`), reusing the intent-classifier invocation pattern (tools disabled, strict JSON schema). One call per project per digest — negligible cost on any model.
- Digest scheduling is flag-gated (`improvements.enabled`, default false) with a CLI entry point for manual runs.

### Phases

1. **Miner + storage + surfacing** (this phase): schema/migration, miner module, daily scheduler that digests when >7 days since last run, `/improvements` dashboard page, `bun run improvements` CLI (digest, list, accept, dismiss).
2. **Bot MRs for accepted proposals**: reuse fix-workspace machinery to open the small AGENTS.md/review.ts MR automatically.
3. **Recurrence tracking + retirement**: match new findings against shipped cluster signatures; report recurrence deltas; propose retiring rules whose class has not recurred for N weeks.

### Relation to review memory

Same pipeline at three altitudes: thread replies → per-MR memory (proposal 0004), finding corpus → per-project rules (this), shipped rules → implementer context hygiene (phase 3 retirement).
