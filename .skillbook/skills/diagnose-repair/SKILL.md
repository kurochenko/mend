---
name: diagnose-repair
description: Diagnose Mend incidents (failed or orphaned review runs, wrong or missing posted findings, webhook or queue anomalies, CI failures without an obvious local cause, recurring regressions) and choose a verified local repair or coherent refactor before changing code. Not for lint, typecheck, or unit failures on the change being written.
license: MIT
compatibility: codex, cursor, opencode, pi, claude-code
metadata:
  audience: developers
  workflow: debugging
---

# Diagnose and Repair

Use this procedure with `coding-general` and the affected specialist skill. It
does not authorize production access, production writes, provider mutations, or
a product redesign. Continue authorized local investigation and repair without
asking again; escalate only a concrete missing decision or permission.

A lint, typecheck, or unit failure caused by the change in progress is ordinary
iteration: fix it under `coding-general` without this procedure.

## Establish the failure

- Reuse the matching beads issue when one exists. Record the symptom, expected
  invariant, project key, MR IID, commit SHA, review run ID, timestamp, and the
  deployed revision. Local HEAD does not prove what production is running.
- Save the first failure and its sanitized evidence before retrying. Do not
  publish tokens, webhook secrets, database URLs, `mend.yml` contents, or raw
  provider payloads.
- Separate observed facts, hypotheses, and unknowns. Group failures by a proven
  shared cause, not similar error text.

Sources of truth, read in this order of authority for the question at hand:

- `review_runs`: `status` (`running`/`success`/`failed`), `source` (`webhook`,
  `replay_iid`, `replay_run`, `replay_benchmark`), `commit_sha`,
  `workflow_run_id`, `input`, `result`, `error`, `duration_ms`. List with
  `bun run runs [<project-key> [<mr-iid>]]` or the `/evals` dashboard.
- `mr_review_queue`: one row per MR with `running_*` and `pending_*`
  event/payload/commit SHA. Startup recovers queue rows and marks orphaned
  `running` runs `failed` (`recoverOrphanedRuns` in `src/db/review-runs.ts`).
- Posted state: `mr_status_notes`, `review_threads`, `review_messages`,
  `review_findings`. Mastra workflow snapshots live in Postgres via
  `@mastra/pg`, keyed by `workflow_run_id`.
- Server logs, tagged `[webhook]`, `[queue]`, `[repo]`, `[review]`,
  `[ensemble]`, `[post]`, `[notes]`, `[startup]`.
- Harness session files under `sessions/<project-key>/mr-<iid>/` (thread
  replies under `sessions/thread-replies/`); inspection diagnostics derive
  from these.
- Provider state: GitLab draft notes, discussions, and notes; GitHub pending
  reviews, review threads, and issue comments; the persistent status note.

Trace only the path needed to locate the first divergence:

`webhook (src/server/*-webhook.ts) -> mr_review_queue -> run-mr-review -> setup -> review harness -> post (publish plan/executor) -> provider publish -> status note sync`

Check provider acceptance, `review_runs`/thread persistence, and the status note
separately when their agreement is the question. Use one meaningful provider
readback. Check `mend.yml` trigger mode, platform, project ID or repo, and
tokens before blaming code.

## Classify and reproduce

Classify with evidence as configuration/infrastructure, application code,
harness/model behavior, test/fixture drift, suspected flakiness, or unresolved.
Classification can change as evidence improves.

- Retry a recognized transient failure once, after preserving evidence and
  confirming retry safety. Missing credentials, wrong permissions, schema drift,
  or deterministic assertions need diagnosis, not retry.
- Do not re-run a publish whose provider acceptance is unknown. Inspect provider
  state first; the post step refuses to publish over pre-existing drafts for a
  reason.
- Reproduce at the narrowest layer: a focused unit test on the pure function,
  then `bun run replay --run <review-run-id>` or
  `bun run replay <project-key> <mr-iid>`. Replay by IID or run ID posts to the
  provider unless the loaded config sets `review.flags.dry_run: true`; only
  `--benchmark` forces dry run.
- Replays against production data or production MRs must be dry-run unless the
  user explicitly approves posting.
- For CI, reproduce the job's split in `.gitlab-ci.yml`: mocked suites run with
  `TEST_DATABASE_URL` unset, real-DB suites in separate processes. Cross-file
  `mock.module` leakage is a known cause (`testing-unit`).
- A passing rerun does not establish flakiness or erase the first failure. Do
  not hide failures with retries, longer sleeps, weakened assertions, or skips.

## Choose the repair boundary

Identify the invariant and its owner before editing. Check `.spec/` flows and
invariants, and apply `feature-layout` when ownership or dependency direction is
implicated: webhook handlers route, steps orchestrate, harnesses run agents,
provider adapters own provider API details, `src/db/` owns persistence, the
post/publish layer owns posting safety.

A local repair fits when the owning contract is sound and one implementation
violates it. Zoom out when several failures need the same rule in different
places, state has competing owners, or successive patches keep exposing the
same boundary. Show the concrete call path or duplicated invariant.

Choose the smallest complete and maintainable repair, not the fewest changed
lines. Do not add locks, retries, or layers solely to silence a symptom. If the
repair changes review behavior or needs an architecture decision, present the
decision while continuing independent evidence gathering.

## Verify and close the loop

1. State root cause, owner, repair scope, and observable acceptance condition
   before implementing.
2. Prove the original failure and important negative paths with focused tests
   (`testing-unit`), then follow `branch-review`.
3. If the failure survives a repair, revisit the hypothesis before another
   edit. Stop an unproductive loop and report the missing fact or decision.
4. Keep local proof, CI status, and deployed behavior distinct; do not claim a
   production fix from local tests or a dry-run replay.
5. Report revisions, environment, root cause, repair rationale, checks run,
   and remaining uncertainty. Record unresolved failures on the existing beads
   issue; without one, report to the user.

Production access and every production write (DB rows, queue entries,
`bun run service-control drain|resume|restart-safe`, provider notes, drafts, or
thread resolution) need explicit authorization. Prepare the exact mutation,
expected terminal state, and rollback before asking. After an authorized
correction, read back the terminal state. Never turn debugging into an
unsolicited provider mutation.
