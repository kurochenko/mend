# Proposal: Review feature — quality and stability improvements

Status: Partially implemented (S1-S3, Q1, Q2, Q5, Q6, and the meta-removal from Q4 done; Q3, Q4-wiring, Q7-Q10 open)
Date: 2026-07-03

## Summary

The review feature's bones are good: layered instructions (base + project overlay), strict Zod output schema with discriminated-union evidence, marker-based note identity, careful diff-base resolution, SHA-level dedup. But several quality levers are inert (the template system selects templates that don't exist; memory suppression can't identify what to suppress), the prompt contradicts itself in update mode, and there are three concrete stability bugs that can wedge an MR or post duplicate reviews.

Ranked below by expected impact. Items S1–S3 are bugs and should land first.

## Stability bugs

### S1. A status-note failure wedges an MR's queue until restart — FIXED

Every path in `runQueuedJob` (`src/server/mr-review-queue.ts:238-353`) calls `upsertStatusNote`, which can throw. A throw propagates past `finishRunningReview`, leaving the queue record's `runningEvent` set forever — new webhooks for that MR queue behind a phantom running job until process restart. The catch block also calls `upsertStatusNote`, so a second failure rethrows.

**Fix:** status notes are cosmetic; wrap every upsert in try/catch-log so they can never take down job accounting.

### S2. A post-step failure after publish causes full duplicate reviews — FIXED

Draft-note recovery is keyed by run ID. If the post step fails *after* bulk publish (e.g. one `createDiscussion` throws), the run is marked failed, the comments are already live, and `hasSuccessfulRunForSha` doesn't block a re-review of the same SHA — which posts a complete duplicate set under a new run ID.

**Fix:** before posting, drop (or convert to a reply on the existing thread) any finding whose fingerprint matches an open previously-published thread — from *any* prior run, not just the previous successful one. This also mechanically enforces "do not repeat previous findings", which today relies on one prompt sentence.

### S3. Update-mode inline positions use the wrong diff base — FIXED

`post.ts:1067-1077` computes line positions from `git diff previousReviewedSha...HEAD` but builds the GitLab position payload with the MR's own `base_sha/start_sha/head_sha`. New-side lines coincide; deletion-anchored comments are numbered against the wrong base — GitLab 400s the draft, reconciliation finds no match, the run fails.

**Fix:** compute positions from the MR's `diffRefs.base_sha` diff, or restrict update-mode inline comments to new-side lines.

## Quality improvements

### Q1. Put the diff in the prompt — DONE

`buildReviewContextPackage` (`src/mastra/review/context-package.ts`) runs `git diff` three ways under a 48k-char budget — and the result is used only for diagnostics counters. The agent must rediscover every changed file through tool calls, which the inspection-enforcement machinery then polices with a full re-run when it misses. Include the changed-file list (with add/delete stats) and the budgeted diff in the system prompt. Highest leverage, lowest risk: grounds the first pass, cuts exploration calls, makes inspection coverage near-automatic, and enables real diff-only scoping.

### Q2. Make memory suppression actually identify the concern — DONE

Memory entries render as bare instructions like "Do not re-raise this concern again on this merge request" — with no file, line, or excerpt. Two dismissals on one MR are indistinguishable; as a false-positive suppressor it cannot work. The needed fields (`matchPath`, `matchLine`, `metadata.sourceBody`) are already persisted (`review-note-events.ts:902-921`) but never surfaced. Render each entry as `[path:line] instruction — original finding: "excerpt"`, and add a post-step filter dropping inline comments that match an active mr-scoped memory anchor (belt and braces).

### Q3. Severity is a category, not a severity

`severity: "bug" | "security" | "performance" | "suggestion"` duplicates `category` and carries no magnitude; there is no rubric for `actionability` or `assessment`, so they drift between runs and harnesses. Change severity to `blocker | major | minor` with a three-line rubric in `agents/AGENTS.md`, derive `assessment` from findings (request_changes iff any blocker or ≥N majors), and add optional per-finding `confidence`. Gives triage and fix batches a real priority signal.

### Q4. Wire the template system or delete the classifier — meta-removal DONE, wiring still open

ADR 0001 specifies intent-routed templates. The LLM classifier runs (one extra call, up to 45s per review), a template is selected — and `buildReviewSystemPrompt` takes no template ID; every review gets the identical prompt. The selected ID is only stamped into diagnostics. The current middle state is the worst option: pay the cost, get none of the value.

**Cheapest real version:** key per-intent instruction blocks in `prompt-templates.ts` by `templateId` (the style/refactor block already exists in AGENTS.md; add bugfix and security blocks). Otherwise delete `intent-llm.ts` and save the call. Also stop asking the model to emit `meta` — the orchestrator overwrites it entirely; it's pure parse-failure surface (`prompt-templates.ts:192-196` vs `steps/review.ts:224-232`).

### Q5. Fix the contradictory update-mode instructions — DONE

`agents/AGENTS.md` says: verify previous findings and answer via `resolutionVerdicts`; do not repeat them as findings. `prompt-templates.ts:128-133` has inverted logic: the "previous findings are context only; do not repeat them unless…" line is emitted only when previous context is *absent* (i.e. on initial reviews, where it's meaningless and contradicts the base rules) and omitted when context is present (where it's needed). Fix the condition and align the wording. Also de-duplicate the "Do NOT review" list, which appears verbatim in both AGENTS.md and the system prompt — pick one canonical home (the system prompt, since codex/opencode don't load AGENTS.md the way pi does).

### Q6. State inline anchoring rules; require evidence substance — DONE

The model is told `"line": 42` with no definition of which side of the diff or whether it must be a changed line; mispositioned comments are silently dropped and reposted as unanchored noise. One sentence fixes most of it: "line is the new-file line number of a line added or changed in `<base>...HEAD`; if you cannot anchor to a changed line, use findings instead." Additionally: `evidence` currently validates when empty — make it `.min(1)` and instruct "re-read the cited lines before emitting; quote the relevant code in evidence".

### Q7. Rework inspection enforcement: continuation + merge, not re-run + replace

Today a coverage miss triggers a *fresh full review* whose result wholesale replaces the first (`inspection.ts:171-189`) — a worse second pass silently discards a good first pass, and the retry prompt references output the new session never produced. Send the retry as a follow-up including the first pass's findings, and union results by fingerprint. Fix the blind spots that trigger pointless retries: `codex-harness.ts` only counts `cat|sed|nl|head|tail|bat` reads (misses `rg`, `git show`, `git diff`); opencode reports no inspected files at all, so it *always* re-runs the entire review — skip enforcement for opencode until it can report.

### Q8. Harden output acquisition uniformly across harnesses

The no-tools JSON retry after malformed output exists only for pi (`review-pipeline.ts:326-330`); for codex/opencode one malformed JSON kills a 20-minute run. Extend the retry to codex (a second `codex exec` with "output only the JSON"). In `lib/json.ts`, prefer the *last schema-valid* balanced object over the *largest* (a big JSON example in prose currently beats the real payload). Align timeouts (opencode defaults to 300s vs 1200s for pi/codex — an accidental 4× divergence). Remove the `context7_lookup` sentence from prompts sent to codex/opencode — the tool exists only in pi, so the prompt invites hallucinated tool calls.

### Q9. Implement ADR 0002 (persisted thread identity)

Thread matching is body-hash based and has already missed in production (suggestion blocks broke the hash — documented in the ADR itself, still "Proposed"). Persisting thread identity removes the whole class of unmatched-verdict bugs.

### Q10. Make the eval measure findings, not counts

`review/eval/scoring.ts` (used by `replay.ts`) scores finding counts in ranges and category presence — it cannot tell a correct review from three plausible-count hallucinations. Extend expectations with `expectedFindings` (file glob, line range, category, matcher) and `forbiddenFindings` (known false-positive traps); score precision/recall; score `resolutionVerdicts` correctness on replayed updates; feed the already-collected `comparisonResult` (pi vs codex) into the same scorer. Run the replay suite on prompt changes — that's what makes Q1–Q6 safely iterable.

## Suggested order

1. S1–S3 (bugs, each small and testable)
2. Q1 + Q5 + Q6 + the `meta` removal from Q4 (prompt-only, one MR, verified via replay)
3. Q2 (memory) and Q3 (severity — schema change, touches formatting/triage)
4. Q10 (eval) — then iterate Q4/Q7/Q8 with a measurable baseline
5. Q9 alongside architecture step 3 (post.ts split), which touches the same code
