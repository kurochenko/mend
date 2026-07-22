---
name: coding-general
description: General coding rules for scoped, simple, verifiable implementation in Mend. Use when implementing or refactoring any code.
license: MIT
compatibility: codex, cursor, opencode, pi, claude-code
metadata:
  audience: developers
  workflow: implementation
---

# Coding General

Mend is an autonomous MR review system. Prefer deterministic orchestration, explicit boundaries, and focused tests over clever agent-specific shortcuts.

## Core Principles

- Correctness first: preserve review safety, idempotency, and clear failure states.
- KISS and YAGNI are default policy.
- Prefer the smallest working vertical slice over broad scaffolding.
- Research facts instead of guessing. Verify Mastra, Codex, GitLab, Drizzle, Bun, and Context7 behavior from installed source, official docs, or command help.
- Keep side effects at boundaries.
- Do not add speculative abstractions, config, schemas, or types without a current caller.

## Workflow

- Read `AGENTS.md` and the relevant `.spec` context before behavior changes.
- Scan for existing helpers and tests before adding new code.
- Add or update focused tests with behavior changes.
- Run `bun run check:agent <file>` after editing TypeScript or JavaScript files.
- Run `bun run review` and `bun run check` before declaring work ready.

## Boundaries

- Webhook handlers parse provider events and route work.
- Queue code owns latest-wins and SHA dedupe behavior.
- Mastra workflow steps orchestrate setup, review, and post.
- Agent harnesses invoke coding agents and return structured results only.
- Review modules own prompts, schemas, diff context, inspection enforcement, diagnostics, and memory prompt shaping.
- Git provider adapters own provider API transport, error classification, discussion/note mapping, and publishing.
- DB modules own persistence and explicit state transitions.

If a boundary lint rule fires and the clean fix is not obvious, stop and ask. Do not weaken the rule or add disables.

## Implementation Guidelines

- Use intent-revealing names.
- Keep functions small and focused.
- Prefer early returns over nested control flow.
- Prefer explicit domain types for non-trivial inputs and outputs.
- Validate unknown input once at the boundary with Zod or a typed parser.
- Keep opaque external payloads as `unknown` until parsed.
- Preserve absence as `null` or `undefined`; avoid sentinel defaults.
- Fail fast with contextual errors.
- Do not swallow errors silently.
- Comments are not allowed except TODOs with a ticket ID.

## Testing

Normal tests must not call live GitLab, live AI agents, or paid external services. Use fakes, fixtures, recorded payloads, or harness test doubles.

High-risk areas need focused tests:

- MR queue dedupe and restart recovery
- diff-base resolution
- file inspection enforcement
- review schema parsing and retry behavior
- GitLab draft-note publishing safety
- thread identity and reply idempotency
- memory extraction and scoping
- harness failure, timeout, and invalid-output handling
