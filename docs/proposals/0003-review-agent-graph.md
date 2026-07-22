# Proposal: structural signals + ensemble review graph

Status: Partially implemented (eval + structural signals context mode done; ensemble harness open)
Date: 2026-07-03

## Summary

Two upgrades to review quality that do not require more spend, just better shape:

1. **Structural signals pre-pass** — deterministic analyzers (dependency cruiser, diff-line police, size metrics) computed per review and injected into the prompt as compact, factual context. Never ask an LLM to compute what a tool computes exactly.
2. **Ensemble review harness** — fan out several small, cheap, *differently-scoped* finder agents plus one strong exploratory agent; verify and dedupe their findings; synthesize one review. Implemented as a new `ReviewAgentHarness` (`ensemble`), so the workflow, queue, and post pipeline do not change at all.

Prerequisite discipline: land the real eval (proposal 0002 Q10) first or alongside, and A/B the ensemble via the existing `comparisonHarness` slot before making it primary. Without measurement this is vibes.

## Part 1 — Structural signals pre-pass

Principle: agents for judgment, tools for computation. Cycles, dependency direction, fan-in, file/function sizes are computable exactly; an LLM re-deriving them is slower, costlier, and sometimes wrong.

Add to the context package (per review, in the worktree):

| Signal | How | Prompt rendering |
| --- | --- | --- |
| New cycles introduced | run the analyzer on base and head, diff the cycle sets | "This MR introduces a dependency cycle: a → b → a" (near-certain finding material) |
| Layering violations touching changed files | analyzer rules where the reviewed repo has them (e.g. its own `.dependency-cruiser.cjs`) | cite the repo's own rule text |
| Blast radius | fan-in of changed modules (import graph) | "`config.ts` is imported by 41 modules — breaking changes here are high-risk" |
| Dependency depth delta | longest import chain through changed modules, base vs head | flag notable growth |
| Size outliers | changed files/functions crossing thresholds (file > ~400 lines, function > ~80) | nudge decomposition findings |
| Diff-police hits | a per-project deterministic scan over ADDED lines only (regex + severity + path filters), in the style of a standalone `scripts/review.ts` | injected as pre-validated candidate findings |

Language support is pluggable: TS/JS first (dependency-cruiser is already a dependency; run it against the reviewed worktree with a generic fallback config when the repo has none), generic signals (sizes, diff police) for everything else. Output is a `## Structural signals` prompt section with a strict size budget, plus machine-readable data in diagnostics.

Two consumption modes:
- **Context mode** (start here): signals inform the reviewing agent; it decides what to report.
- **Auto-finding mode** (later): unambiguous regressions (new cycle, error-level layering violation) become findings directly, with the agent only writing the explanation. Zero hallucination surface.

### Also adopt from earlier review setups

- **Per-project "common regressions" list**: a curated section in `skills/{project}/AGENTS.md` of mistakes that actually happened in that repo. Highest-signal prompt material there is; review memory (now that it carries path/line/excerpts) can semi-automate growing it.
- **Path-routed skill loading**: classify changed paths and include only the matching per-topic skill files in the prompt instead of one monolithic project file.
- **Decision-doc anchors**: when a project has `docs/**/decisions/*.md`, tell the reviewer to treat referenced decisions as intentional — separates "odd but decided" from "bug".

## Part 2 — Ensemble review graph

### Assessment of the fan-out idea

Sound, with three corrections that determine whether it improves or degrades reviews:

1. **Dimensions must differ by *what they read and do*, not just by hat.** Five agents given the same diff with different instructions ("you do security", "you do style") mostly converge on the same shallow findings. The wins come from different retrieval patterns per finder (see table).
2. **Fan-out raises recall; a verification stage must restore precision.** N finders produce duplicates, contradictions, and noise — and developers stop reading noisy reviews. The orchestrator cannot just compile; it must dedupe (fingerprints exist already), adversarially verify (cheap per-finding "try to refute this against the code" checks), and rank.
3. **Keep one strong deep agent.** Cross-cutting, compositional bugs do not fall into dimension buckets. One full-context exploratory agent with the strongest model is the expensive slot that the cheap finders subsidize.

### Graph

```
context package + structural signals
        │
        ├─ finder: diff correctness      (cheap model; reads diff hunks + enclosing functions;
        │                                 hunts logic bugs, edge cases, contract breaks)
        ├─ finder: cross-file impact     (cheap model; reads callers/callees of changed symbols —
        │                                 the call-graph slice; hunts breaking changes)
        ├─ finder: tests adequacy        (cheap model; reads changed code + its tests;
        │                                 verifies regression coverage claims)
        ├─ finder: conventions + structure (cheap model; project skills + structural signals digest;
        │                                 triages tool findings into human-worthy ones)
        └─ deep exploration              (strong model; full package, free tool use;
                                          compositional and domain bugs)
        │
   verify stage: per candidate finding, a small-context refutation check (cheap model);
                 drop refuted; merge duplicates by fingerprint
        │
   synthesizer (strong model): resolutionVerdicts, severity consistency, summary,
                 assemble final ReviewOutputV2
```

Cost shape: 4 cheap finders with *small* contexts + tiny verify calls + 1 strong deep agent + 1 strong synthesis ≈ the cost of today's single long full-strength session, often less — and wall-clock drops because finders run in parallel. "Better results, not more cost" is achievable because today one model pays full price to do all of these jobs badly-averaged in one giant context.

### Implementation fit (the nice part)

`ReviewAgentHarness` is already a pluggable contract, and `invokeReviewAgent` already supports harness selection plus a `comparisonHarness` racing slot. The whole graph becomes one new harness:

- `src/agents/ensemble-harness.ts` — fans out sub-reviews (each finder is a pi session with a configurable model, or a `codex exec` subprocess for GPT-class minis), runs verify + synthesis, returns a single `ReviewOutputV2`. Queue, workflow, post step: untouched.
- Config: `review.harness: ensemble` + a model map per role (`finders`, `verifier`, `deep`, `synthesizer`), so model choice is a config concern, not code.
- Failure containment: any finder failing → proceed without it (log in diagnostics); ensemble failing wholesale → fall back to the single-harness review.
- Finder sub-prompts reuse `buildReviewSystemPrompt` sections plus a role block; output schema per finder is a *reduced* candidate-finding schema (no assessment/summary — only the synthesizer emits those).

### Sequencing

1. **Eval first (0002 Q10)** — DONE (expected/forbidden expectations, recall/FP/verdict scoring, comparison-harness side-by-side, --json).
2. **Structural signals** (Part 1, context mode) — DONE (`src/mastra/review/structural-signals.ts`: base-vs-head cycle diff, fan-in blast radius, repo-own-config rule violations, size outliers; flag `review.flags.structural_signals`).
3. **Ensemble harness v1** (finders + dedupe + synthesizer, skip verify stage initially) behind config, run as `comparisonHarness` next to pi on real MRs — production A/B data at zero risk, scored by the eval.
4. **Verify stage + auto-finding mode**, tuned against eval numbers; promote ensemble to primary when it wins on precision AND recall.
