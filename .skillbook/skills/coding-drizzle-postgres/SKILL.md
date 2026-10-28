---
name: coding-drizzle-postgres
description: Postgres and Drizzle patterns for Mend. Use when designing schema, writing migrations, or implementing typed database access under src/db/.
license: MIT
compatibility: codex, cursor, opencode, pi, claude-code
metadata:
  audience: developers
  workflow: implementation
---

# Coding Drizzle Postgres

Mend persists to plain Postgres through Drizzle (`drizzle-orm/postgres-js`).
`src/db/schema.ts` is the table inventory: `review_runs`, `mr_review_queue`,
`mr_status_notes`, `review_threads`, `review_messages`,
`review_findings`, `review_memory_entries`, `review_memory_events`,
`improvement_proposals`, `service_runtime`. Extend these before inventing a
parallel table. Mastra's `@mastra/pg` store shares the database and owns its own
tables; never read or write them from `src/db/`.

## Core Rules

- Scope every MR-level row by `project_key` plus `mr_iid`; one config can serve
  several projects and providers.
- Keep provider identity first-class: `provider` plus the provider's thread,
  message, or note ID, backed by a unique index.
- All schema changes go through migrations. No runtime `CREATE`/`ALTER`.
- Keep schema, Zod IO schemas, and domain types aligned. Export status value
  arrays next to their `pgEnum` (`reviewFindingStateValues`) and derive types from
  them.
- `DATABASE_URL` is read and validated in `src/config.ts`; `src/db/` code gets
  the connection through `initDb`/`getDb` in `src/db/client.ts`, never
  `process.env`.

## Table Design

- Operational tables carry `created_at` and `updated_at` (`withTimezone: true`).
- Use foreign keys with deliberate `onDelete` semantics: `cascade` for owned
  children (`review_messages` to `review_threads`), `set null` for history that
  must outlive its source (`review_memory_events`).
- Add unique indexes for idempotent ingestion paths, e.g.
  `(provider, provider_message_id)` and `(project_key, mr_iid)` for one-per-MR
  state such as `mr_status_notes`.
- Index intentionally for queue, worker, and dashboard lookups (state, run ID,
  MR scope).
- IDs are application-generated text. Generate them in one place per table
  (`crypto.randomUUID()` in the insert helper, or a named helper such as
  `queueId(projectKey, mrIid)`), not ad hoc at call sites.
- Keep raw provider payloads (`raw_provider_data`, `webhook_payload`) in `jsonb`
  beside normalized columns; model known keys in Zod when reading them back.

## Relational review

Keep each fact in one authoritative row. Denormalize only for a demonstrated
need with an explicit consistency owner. Enforce required relationships and
uniqueness with constraints, not caller discipline. Schema and code must coexist
with the previous deployment during a rollout and with in-flight queue rows and
`running` review runs across a restart.

## Drizzle Patterns

- Each table's queries live in its `src/db/<name>.ts` module; other layers call
  named functions, not the query builder.
- Persist state transitions through named functions (`claimPendingReviewJob`,
  `finishRunningReview`, `recoverOrphanedRuns`), not generic partial patches.
- Return named record types, not anonymous rows.
- No untyped string SQL in application code. The `sql` tag is for expressions
  Drizzle cannot build and for test or migration helpers.
- Claim work with a conditional `update ... where <state> returning` (see
  `claimPendingReviewMessage` in `src/db/review-threads.ts`) or a unique index
  with `onConflictDoNothing`/`onConflictDoUpdate`. Do not add advisory locks for
  invariants a constraint can express.

## Transactions

- Use a transaction when one operation writes several rows or tables that must
  agree (`upsertReviewMessage` in `src/db/review-threads.ts`).
- Keep them short. Never hold one open across provider calls, harness runs,
  git operations, or workflow steps.
- Read outside the transaction when the read is not part of the invariant.
- No `Promise.all` on `tx`; a transaction is one connection.

## Migrations

1. Edit `src/db/schema.ts`.
2. `bun run db:generate` writes `drizzle/NNNN_<name>.sql` and `drizzle/meta/`.
   Commit both, and review the SQL for destructive or locking statements.
3. Apply with `bun run db:migrate`; the server does not migrate on startup.
4. Never edit a migration that has been applied anywhere; add a new one.
   Backfills of existing rows belong in the migration SQL, not runtime code.
5. Running migrations against production is a production write and needs
   explicit authorization.

Test DB helpers against real Postgres (`bun run db:test:setup`, then
`bun run test:db`); see `testing-unit`.

## Idempotency

- Webhooks and replays must be safely replayable: upsert on provider identity,
  and dedup on stored commit SHA before doing work.
- Record enough metadata (`source`, `commit_sha`, `workflow_run_id`) to trace
  why a run or post happened.

## Pitfalls

- Do not key rows by usernames, MR titles, or note bodies.
- Do not merge queue state, run history, and posted-thread state into one table.
- Do not skip unique constraints on webhook-driven or provider-synced data.
