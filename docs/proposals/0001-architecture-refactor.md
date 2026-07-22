# Proposal: Architecture refactor for testability

Status: Partially implemented (steps 1-3 and 5 done, plus GitLabClient from step 2; steps 4, 6, 7 open)
Date: 2026-07-03

## Summary

The high-level flow (webhook → queue → workflow → harness → post) matches the stated architecture, but the lower layers violate it: dependency arrows point upward (`lib` → `mastra`, `db` → `server`, `db` → `mastra`), one live import cycle exists, and three god modules concentrate most of the risk. The biggest problem is testability: the safety-critical publishing logic (1,516-line `post.ts`) and the note-event handling (985-line `review-note-events.ts`) can only be tested through global `mock.module` patching, which tests wiring, not behavior.

This proposal defines a target layout and an incremental order. No big-bang rewrite; every step keeps `bun run check` green.

## Findings

### Layering violations

| Violation | Where | Fix |
| --- | --- | --- |
| `lib` → `mastra` | `src/lib/review-threads.ts` imports `hashBody` from `@/mastra/review/markers` | move `hashBody` to `src/lib/hash.ts` |
| `db` → `mastra` | `src/db/review-runs.ts` imports `MrReviewInput` from `@/mastra/steps/setup` | move the schema to a neutral module |
| `db` → `server` | `src/db/review-queue.ts` imports `MrReviewRequestEvent` from `@/server/status-notes` — a domain type defined in a Markdown-rendering file, re-exported twice | move the event type to a neutral module |
| Import cycle | `steps/post.ts` ↔ `review/previous-context.ts` (via `postStepOutputSchema`) | extract an owned `run-result` schema |
| Server parses step internals | `review-note-events.ts` re-parses `review_runs.result` with `postStepOutputSchema` | same `run-result` schema |
| Re-export shim | `server/status-notes.ts` is 90% re-exports (violates the repo's own no-barrel rule) | delete, import from sources |

These are covered by dependency-cruiser rules that currently cannot fire because they reference a directory (`src/git-service/`) that does not exist. Batch B of the hardening pass fixes the rules and the violations together and escalates them to errors.

### God modules

- **`src/mastra/steps/post.ts` (1,516 lines, ~12 concerns):** schemas, pure output filtering, diff-position computation, draft-note safety/recovery, four copy-pasted create-with-reconciliation wrappers, marker embedding, DB mirroring, thread resolution, reply persistence (duplicated vs `review-note-events.ts`), fix-batch queueing, dry-run branches interleaved into every write path, diagnostics.
- **`src/server/review-note-events.ts` (985 lines):** one 385-line function handling payload parsing, thread-context derivation (duplicated vs post.ts), discussion backfill, a message-inbox state machine, addressing policy, reactions, triage commands, fix-batch kickoff, conversation planning, LLM replies, and run-context reconstruction.
- **`src/server/mr-review-queue.ts` (532 lines):** roughly three modules — worker engine, review-job runner, and a status-note synchronizer that owns GitLab note CRUD (provider detail inside queue orchestration).

### Testability

Dependency style is bimodal. The newest code (fix loop) uses explicit deps objects with defaults (`FixBatchRunnerDependencies`) — the right pattern, already established in this repo. Everything older imports singletons (`getProject()`, `getDb()`, GitLab free functions), so tests patch modules globally: 9 `mock.module` calls to test `review-note-events`, 8 for `mr-review-queue`. The GitLab functions themselves have good shape (every one takes `ProjectConfig` as first arg — no global token state); what is missing is a client object to substitute.

The workflow cannot run against fakes today: steps receive only `inputData` from Mastra and reach for singletons internally. The one injectable seam (`harnesses` in `invokeReviewAgent`) is not threaded through `reviewStep`.

### Duplication

- Outbound-reply persistence written three times (`post.ts`, `review-note-events.ts` ×2 forms).
- Marker→thread-context mapping written twice (`deriveThreadContext` vs `collectPersistableGitLabDiscussions`).
- `postStepOutputSchema` parsed from stored JSON in two distant places.
- Four copies of the create/list/match-by-body reconciliation pattern in post.ts.
- `gitlabApi` / `gitlabApiGlobal` in `transport.ts` are near-identical 45-line twins.
- Two modules named `review-threads` (lib = types/fingerprints, db = persistence) — confusing; the lib one leaks a mastra import.

### State and concurrency

Postgres holds the queue, runs, status notes, threads, and the draining flag; recovery on restart is decent. Two real gaps:

1. **All mutual exclusion is per-process** (`mrLocks` promise map). Any overlap of two instances (deploys before drain completes) can double-claim an MR. Fix: claim rows via `UPDATE … WHERE … RETURNING` or Postgres advisory locks.
2. **Note events bypass the per-MR lock/queue entirely** — `gitlab-webhook.ts` fire-and-forgets `processGitlabMergeRequestNote`. Concurrent notes interleave against GitLab; a crash between `replyToDiscussion` and local persistence is papered over by body matching.

## Target layout

```
src/
  transport/            gitlab-webhook: parse, verify, classify, dispatch — nothing else
  domain/review/        PURE (no db/integrations/mastra imports):
                        markers, fingerprints, thread-context (unified), publish-plan,
                        conversation planning, status-note rendering, run-result schema, events
  providers/gitlab/     existing functions + client.ts (GitLabClient interface,
                        createGitLabClient(project)) + one generic idempotent.ts wrapper
  agents/               unchanged — ReviewAgentHarness is already the right port
  persistence/          was db/; grouped per aggregate into passed-in store objects
  services/             stateful, DI'd: review-queue (worker engine), review-job,
                        status-note-sync, note-inbox, note-handlers/{triage,memory,llm-reply},
                        thread-sync, thread-resolution, fix-batches
  mastra/               thin: workflow def + 3 steps that unwrap inputData and call services
  app/context.ts        composition root: createAppContext(config) → { gitlab, stores, harnesses }
```

Key seams:

1. **`GitLabClient` interface** wrapping the existing per-project functions; a `FakeGitLabClient` (in-memory MR with notes/discussions) replaces `mock.module` collages.
2. **Step bodies as plain functions** — `runSetupStep(deps, input)` etc.; Mastra `createStep` wrappers stay ~10 lines and call them with production deps. This is how the whole workflow becomes runnable against fakes.
3. **Plan/execute split for posting** — `buildPostPlan(reviewOutput, diffMap, flags): PostPlan` (pure, instantly unit-testable) then `executePostPlan(plan, gitlab, stores)`. Dry-run becomes "render the plan and stop", deleting every interleaved `if (dryRun)` branch.
4. **Owned `run-result` schema** for `review_runs.result`, breaking the cycle and the server→step import.
5. **Stores as deps objects** following the existing `FixBatchRunnerDependencies` pattern — no repository-class ceremony.

## Incremental order

1. **Mechanical layering fixes** — DONE (dependency rules are now error-level).
2. **`run-result` schema + `GitLabClient`** — DONE (`src/mastra/review/run-result.ts`, `src/integrations/gitlab/client.ts`).
3. **Split post.ts** via plan/execute — DONE (`publish-plan.ts` pure, `publish-executor.ts`, `idempotent.ts`, `thread-sync.ts`, `thread-resolution.ts`; fix queueing moved to the queue job; post.ts is 163 lines).
4. **Split review-note-events**: note-inbox, unified thread-context, note-router + handlers. Then delete most `mock.module` usage in its tests.
5. **Extract status-note-sync** — DONE (`src/server/status-note-sync.ts`, non-throwing).
6. **Route note processing through the per-MR queue/lock; add cross-process claim semantics** — a correctness fix the new seams make cheap.
7. **Thread deps through the step wrappers**; add an end-to-end workflow test against `FakeGitLabClient` + scripted fake harness (the e2e harness from the hardening pass already proves the pattern at the HTTP layer).

Steps 1–2 are low-risk and can land immediately. Step 3 is the one to prioritize: post.ts is the least-tested, most business-critical file in the repo.
