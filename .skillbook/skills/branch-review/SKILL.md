---
name: branch-review
description: Validate a settled Mend change and distinguish local completion, MR validation, and merge readiness. Use before saying work is ready, asking for review, committing, or opening an MR; scale checks to the changed surface.
license: MIT
compatibility: codex, cursor, opencode, pi, claude-code
metadata:
  audience: developers
  workflow: review
---

# Branch Review

This skill owns validation stages; `code-review-general` owns review judgment and
`git` owns publication. Carry forward the user's authorization and integration
target (`origin/main` otherwise). Do not turn every local handoff into a
merge-ready claim, and do not run this after every small edit.

## Local implementation

While iterating, run `bun run check:agent <file>` for each touched TypeScript or
JavaScript file plus the narrowest focused test. Review the final diff with
`code-review-general` at a depth proportionate to risk.

Run the diff-level scan against the target:

```bash
bun run review --base origin/main
```

Without `--base` it diffs against `HEAD`, which covers only uncommitted work and
is not final-diff evidence. Local completion means the requested change and its
relevant checks are done; it claims nothing about the MR pipeline or live behavior.

## MR validation

Run the full gate once the implementation is settled:

```bash
bun run check
```

If it fails because of unrelated existing worktree debt, report the failing
command and keep the change scoped. Record the revision and result of each check
and reuse that evidence until a later diff invalidates it. The pre-push hook
reruns `bun run check` and the public-token guard; never bypass it.

Add proof for the changed surface:

- Review execution, queueing, posting, thread handling, memory, diff-base
  resolution, or harness changes need focused tests covering success and failure.
- End-to-end posting or workflow changes: `bun run test:e2e` (fake GitLab, needs
  `TEST_DATABASE_URL`).
- Schema or DB module changes: `bun run db:generate` for migrations, then
  `bun run db:test:setup` and `bun run test:db` against a test database. DB suites
  skip silently without `TEST_DATABASE_URL`; if not run locally, say so and rely
  on the MR pipeline.
- Prompt, template, or review-quality changes: `bun run replay --benchmark
  <config.json>` when matching fixtures exist; otherwise record the gap.

## Common Mend Regressions

- Speculative harness or provider abstractions without a selected caller.
- Provider payload shapes leaking into review or workflow logic.
- Posting or publishing notes outside the post/publish layer, or weakening the
  pre-existing-draft refusal.
- GitLab-only fixes that break GitHub parity behind the `ReviewProvider` port.
- Live AI, provider, or network calls in normal tests; unrestored `mock.module`.
- Review behavior changes without replay, eval, or test coverage.
- Weakening lint, dependency, or architecture rules instead of fixing ownership.

## Follow-ups

After green validation, a localized follow-up needs affected checks and a
final-diff review. Repeat the full gate when the follow-up broadens behavior or
architecture, changes dependencies or schema, follows rebase conflicts, causes a
focused failure, or leaves a material verification gap.

## Merge readiness

Only call an MR merge-ready when:

- Its current head contains the reviewed change and is integrated with the target
  as `git` requires.
- The MR pipeline (lint, typecheck, test with Postgres, e2e) passes on that head.
- Required focused proof is complete and review findings are resolved by verified
  fixes or evidence-backed decisions.
- The MR targets `main`, and its title and description follow `git`.

## Commit and MR hygiene

- Branches are short kebab-case with a type prefix: `feat/codex-reviewer`,
  `fix/status-note-sync`.
- Commit subjects and MR titles use Conventional Commits, with the Beads ticket id
  when one exists: `feat: [MEND-c8t] add quality gates`.
- MR descriptions summarize what changed, the user or system value, and durable
  decisions. Keep verification logs out unless asked.

Report what changed, what passed, what remains pending, and which stage is
complete. Committing, pushing, or merging requires the corresponding user
authorization; readiness does not grant it.
