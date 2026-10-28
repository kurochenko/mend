---
name: coding-general
description: General coding rules for scoped, simple, verifiable implementation in Mend. Use when implementing, fixing, or refactoring any code.
license: MIT
compatibility: codex, cursor, opencode, pi, claude-code
metadata:
  audience: developers
  workflow: implementation
---

# Coding General

Implement the smallest complete change that satisfies the request and preserves review
safety, idempotency, and clear failure states. Read `AGENTS.md`, then inspect the
affected execution path (webhook -> queue -> workflow step -> harness/provider/db)
before editing. For an incident or recurring failure, use
`diagnose-repair` to establish the cause first.

## Ownership and scope

`feature-layout` owns module placement and dependency boundaries. Webhook handlers parse
and route, queue code owns latest-wins and SHA dedup, workflow steps orchestrate, harnesses
only run coding agents, provider adapters own provider API details, DB modules own
persistence, and posting safety stays in the post/publish layer.

Prefer locality and existing helpers (`src/lib/exec.ts`, `src/lib/json.ts`,
`src/lib/diff.ts`, `src/integrations/idempotent.ts`). Add abstractions only for a
demonstrated boundary or shared invariant; no speculative code, config, schemas, or types
without a current caller (`knip` enforces unused exports). Avoid passive forwarding layers
and unrelated cleanup. Use the user's existing authorization; ask only when a question
resolves material uncertainty.

## Repository conventions

- Use Bun and existing `package.json` scripts. `coding-typescript` owns import, type, and
  schema conventions.
- No comments except TODOs with a ticket ID. No lint disables, baseline increases, or rule
  weakening without approval.
- Verify Mastra, Codex, Pi, OpenCode, GitLab, GitHub, Drizzle, Bun, and Context7 behavior from
  installed source, official docs, or command help, not memory.
- Expected provider/harness states (draft conflicts, missing threads, timeouts, invalid
  output) get typed handling; unexpected defects fail fast with contextual errors. Never
  swallow errors silently or log secrets and raw provider payloads.
- Reuse installed packages and platform APIs. Before adding a dependency verify Bun
  compatibility, maintenance, and cost. Never hand-edit generated files (`drizzle/`).

## Resource budgets

Mend ingests untrusted and unbounded inputs. Apply limits before expensive work, using the
owning config or named constant as the source of truth, and trace peak live data across a
whole review, including concurrent queue workers and retained results.

- Webhook bodies: authenticate (GitLab token, GitHub HMAC) before parsing or doing work;
  treat `Content-Length` as a hint only.
- Diffs and context: budget prompt sections by characters or items and record what was cut
  (as `prompt-templates.ts` lists files not fully included) so the agent can inspect the
  rest with tools. Truncation must be visible, never silent.
- Harness output and subprocesses: every agent run has a timeout; parse output once with
  `extractJson` plus Zod `safeParse`; do not retain full transcripts or stdout beyond what
  diagnostics need.
- Provider pagination: follow `x-next-page` / `hasNextPage` cursors explicitly and bound how
  many results feed prompts or notes; do not refetch unchanged threads within a run.
- Concurrency: one worker per MR key (`mr-locks.ts`, `repo-locks.ts`); keep worktrees,
  sessions, and payloads scoped to that run and cleaned up on every exit path.
- Prove each limit at its boundary with hostile inputs: huge diffs, many files, long
  harness output, many pages, concurrent webhooks for one MR. Assert bounded work, useful
  partial results, and recovery.

## Verification

Prove changed behavior and material failure cases at the cheapest reliable layer; use
`testing-unit` for focused tests. Normal tests never call live GitLab, GitHub, coding agents,
or paid services; use fakes, recorded payloads, and harness doubles. Avoid tests that only
mirror a reversible, low-impact implementation.

High-risk areas always need focused tests: queue dedup and restart recovery, diff-base
resolution, inspection enforcement, review schema parsing and retry, draft/pending-review
publishing safety, thread identity and reply idempotency, memory scoping, and harness
failure, timeout, and invalid output.

Run `bun run check:agent <file>` for each touched file and the narrowest covering test while
iterating; use `branch-review` (`bun run review`, `bun run check`) for final validation.
Repeat or broaden checks only for new changes, failures, or remaining uncertainty. Report
what was actually verified and any material gap.
