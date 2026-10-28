---
name: testing-unit
description: Unit and integration test patterns for Mend with bun test: what to test, designing for testability, mock.module seams and their cross-file leakage, ReviewProvider fakes, real-DB suites, and error assertions. Use when writing or reviewing *.test.ts files or deciding test strategy for a change.
license: MIT
compatibility: codex, cursor, opencode, pi, claude-code
metadata:
  audience: developers
  workflow: testing
---

# Unit Testing

How Mend tests each layer, and how to design code so tests stay cheap.
`AGENTS.md`: any change to review execution, queueing, posting, thread handling,
memory, diff-base resolution, or harness behavior adds or updates focused tests;
if that is not practical, say why before proceeding.

## Test what matters

Test decision logic where a wrong branch posts a bad review, drops or duplicates
a queued review, publishes someone else's drafts, mis-resolves a thread, or picks
the wrong diff base. There is no per-file mandate. Ask what review- or
state-visible behavior a test protects.

- No mock-wiring tests. Assertions that only restate `toHaveBeenCalledWith(...)`
  on mocked seams break on refactor and catch nothing. Call-argument assertions
  are fine when the argument is the contract (the exact note body or review
  payload sent to the provider, the commit SHA claimed from the queue).
- Trivial mappers and pass-through glue need no tests. Deleting a low-value
  test is an improvement.

## Layers

| Layer | Test | Location |
| --- | --- | --- |
| Pure decision logic (publish plan, diff base, blocking policy, inspection, schema parsing) | `bun:test`, no mocks | `src/**/<name>.test.ts` next to the source |
| Orchestrators with branching (queue, thread sync, status notes, note events) | `bun:test` with `mock.module` seams or a `ReviewProvider` fake | next to the source |
| `src/db/` persistence helpers | Real Postgres, skipped without `TEST_DATABASE_URL` | `src/db/<name>.test.ts` |
| Full webhook-to-post flow | e2e against `tests/e2e/fake-gitlab.ts` and a real DB | `tests/e2e/*.e2e.ts` |

- `bun run test` runs `bun test ./src`; `bun run test:db` runs `src/db`;
  `bun run test:e2e` runs `tests/e2e/*.e2e.ts`. Real-DB runs need
  `TEST_DATABASE_URL` (compose `postgres-test` on port 5435) and
  `bun run db:test:setup`.
- Non-DB tests are hermetic: no network, no real provider, no `.env` or
  `mend.yml`, no real harness run.

## Design for testability

1. **Extract a pure core.** Decisions and payload building go in exported pure
   functions, as in `src/mastra/review/publish-plan.ts` (tested directly in
   `src/mastra/steps/post.test.ts`) while `publish-executor.ts` performs I/O.
2. **Mock module seams with `mock.module`.** Replace the `@/db/*`,
   `@/agents/*`, or `@/integrations/*` modules the unit owns a contract with,
   then load the unit with `await import(...)` after the mocks, as in
   `src/server/mr-review-queue.test.ts`. Never mock the unit's own helpers.
3. **Fakes for wide providers.** Build a typed `ReviewProvider` object of
   `mock(...)` methods (`makeProvider` in `src/server/status-note-sync.test.ts`).
   Swap harnesses through `setReviewHarnessOverridesForTesting` in
   `src/agents/harness-overrides.ts`.

Needing six mocks or asserting side-effect order is a design signal: split the
pure core out first.

## mock.module leaks across files

`mock.module` registrations are process-global for the whole `bun test` run and
mutate the already-imported module namespace in place. A later file that imports
a mocked `@/db/*` module gets the mock, and file order is not alphabetical. The
symptom is "impossible" assertions holding another suite's fixture values.

- The repo isolates by process: `.gitlab-ci.yml` runs `bun test ./src` with
  `TEST_DATABASE_URL` unset, then each real-DB suite in its own `bun test <file>`.
  A new real-DB suite must be added to that list or it never runs in CI.
- If a mocked module must coexist with its real consumers in one process,
  snapshot `const real = { ...(await import('@/db/x')) }` before the first
  `mock.module` and restore with `afterAll(() => mock.module('@/db/x', () => real))`.
  Restoring from `import * as actual` re-registers the mock, because that
  namespace was mutated.
- Reset seam mocks in `beforeEach` (`mockReset()`), as the queue tests do.
- Real-DB suites namespace their keys (`review-runs-test-${crypto.randomUUID()}`)
  and delete their own rows so provider-scoped unique indexes cannot collide.

## Shape of a test

- `describe` per exported function, one `test`/`it` per behavior in domain
  language ("skips when the exact SHA was already reviewed"), arrange-act-assert.
- Small typed local builders with per-test overrides; avoid `as never` and broad
  casts unless a boundary type truly cannot be constructed.
- Fixed `new Date('...')` constants; never `Date.now()` in assertions.
- Assert outcomes: returned value, persisted row, provider payload. Assert call
  order only when the order is the invariant (create drafts before bulk publish).

## Errors

- Expected failures are typed: branch on the class or discriminant
  (`ProviderApiError` with `status`, `ReviewOutputParseError`), not on message
  substrings. Exact `toThrow('...')` messages are fine for config validation,
  where the message is the user-facing contract.
- Cover the non-throwing paths that must stay non-throwing, such as status-note
  sync on provider 403/404.
- Do not assert logging unless the log line is the observable contract.

## What not to do

- No unit tests that serve Hono on localhost or call real GitLab or GitHub;
  that is `tests/e2e/` territory. No test runs a real coding agent, e2e
  included.
- No mocking Drizzle or the DB client inside `src/db/` tests; use the real-DB
  suite, or extract a pure mapper.
- No snapshot tests for review output; assert the fields that carry the invariant.
- Do not weaken a type or export a private helper solely for testing.
