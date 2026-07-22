---
name: branch-review
description: Use after a logical implementation slice and before saying Mend work is ready, asking for review, staging, or committing. Combines deterministic review checks with judgment-based code review.
license: MIT
compatibility: codex, cursor, opencode, pi, claude-code
metadata:
  audience: developers
  workflow: review
---

# Branch Review

Use this before declaring work ready, creating an MR, or committing. Do not run it after every small edit; use `bun run check:agent <file>` during normal editing.

## Mechanical Checks

Start with:

```bash
bun run review
```

Then run:

```bash
bun run check
```

If the full gate fails because of unrelated existing worktree debt, report the failing command and keep the current change scoped.

## Judgment Checks

Review the diff for Mend-specific risk:

- Webhook handlers parse and route events; they should not own provider recovery, posting, or persistence orchestration.
- Mastra workflow steps should have clear ownership: setup prepares worktrees, review invokes and validates reviewers, post publishes safely.
- Agent harnesses should run coding agents only. They should not know GitLab posting, status notes, or DB persistence.
- Git provider adapters own provider API details, request parameters, pagination, error classification, and provider-to-domain mapping.
- DB modules own persistence and state transitions. Multi-row or related state changes should be transactional where practical.
- Review output schemas and prompt contracts must stay deterministic and covered by tests.
- Draft-note and publish safety changes need focused tests.
- Queue, diff-base, previous-context, thread, and memory behavior changes need focused tests.

## Common Mend Regressions

- Adding speculative harness abstractions without a selected caller.
- Letting provider payload shapes leak into review/domain logic.
- Posting or publishing GitLab notes outside the post/publish layer.
- Introducing live AI, GitLab, or network calls into normal tests.
- Changing review behavior without updating replay/eval/test coverage.
- Weakening lint, dependency, or architecture rules instead of fixing ownership.

## Commit and MR Hygiene

- Branches use short kebab-case with a type prefix, for example `feat/codex-reviewer` or `fix/status-note-sync`.
- Commit subjects and MR titles use Conventional Commits.
- If a change has a Beads ticket, include the id in both the commit subject and MR title, for example `feat: [MEND-c8t] add quality gates`.
- MR descriptions should summarize what changed, the user or system value, and durable decisions. Keep verification logs out unless the user asks for them.

End with what changed, what passed, and remaining risks. Do not commit unless the user explicitly asked for a commit.
