# Mend

Autonomous agentic system for MR code review. Triggered from GitLab webhooks. Uses Mastra for workflow orchestration and a selectable coding-agent harness for review execution.

## Stack

Bun, TypeScript, Hono, Mastra, Codex CLI, Pi (`@mariozechner/pi-coding-agent`), OpenCode, Drizzle, Postgres, Zod, Context7

## Architecture

Three-step Mastra workflow: **setup** (clone/worktree) → **review** (selectable coding-agent harness) → **post** (GitLab draft notes).

- Mastra owns the workflow: webhook routing, worktree lifecycle, run logging, workflow state.
- The configured review harness (`pi`, `codex`, or `opencode`) owns the review: reads code, inspects changed files where supported, and produces structured findings.
- LLM-based intent classification (via Pi with tools disabled) determines review template selection.
- Reviews run in **initial** or **update** mode. Update mode resolves the diff base by trying candidates in order: previous reviewed SHA → `start_sha` → `base_sha` → target branch, with fetch-and-retry fallback.
- File inspection is enforced with retry from harness session diagnostics where available. If any files are missed after the first pass, a retry prompt lists the missing files explicitly; remaining gaps are recorded as warnings.
- Reviews are posted as GitLab draft notes, bulk-published after all notes are created. The post step refuses to publish if pre-existing draft notes are found (safety check against publishing someone else's drafts).
- A DB-backed queue (`mr_review_queue`) with in-process workers deduplicates concurrent reviews per MR (latest-wins) with SHA-level dedup (skips if the exact SHA was already reviewed successfully). Updates a persistent MR status note (`queued`/`running`/`completed`/`failed`/`no_change`).
- On startup, orphaned `running` review runs are marked as `failed`.
- Dry run mode (`review.flags.dry_run`) skips all GitLab posting; logs draft note bodies to stdout.
- An evals dashboard at `/evals` renders review run history with filtering by project.

Only MR review is implemented. Bug fix workflow, Slack integration, label-triggered reviews, and suspend/resume for reply watching are not built yet. MR note webhooks are processed for triage commands, thread replies, and memory.

## Key Directories

- `src/index.ts` — entry point: boots Mastra, Hono server, webhook routes
- `src/config.ts` — loads and validates `mend.yml` project config (Zod schemas)
- `src/server/` — GitLab webhook handler, MR review queue, evals dashboard
- `src/server/status-note-body.ts` — persistent MR status note rendering
- `src/server/status-note-sync.ts` — persistent MR status note sync (non-throwing GitLab upsert)
- `src/server/review-context.ts` — previous run lookup and SHA-level dedup helpers for update reviews
- `src/mastra/` — Mastra instance, workflow definition, steps (setup, review, post)
- `src/mastra/workflows/` — workflow definitions (currently `mr-review.ts`)
- `src/mastra/run-mr-review.ts` — workflow execution wrapper with run persistence and failure handling
- `src/mastra/review/` — intent classifier, template selection, prompt construction, output schema, context package, diff base resolution, publish plan/executor, formatting, inspection enforcement, diagnostics, eval scoring
- `src/mastra/steps/` — the three workflow steps (setup, review, post)
- `src/agents/` — coding-agent harness adapters and shared harness contract (`pi`, `codex`, `opencode`)
- `src/integrations/gitlab/` — GitLab REST API functions and `GitLabClient` port (MR details, draft notes, note/discussion CRUD)
- `src/integrations/repo.ts` — bare clone management, worktree creation/cleanup
- `src/integrations/context7.ts` — Context7 documentation lookup (registered as Pi tool)
- `src/db/` — Drizzle schema (`review_runs` table), DB client, run CRUD
- `src/cli/` — replay and runs CLI tools
- `src/lib/` — shared utilities (diff parser for inline comment positioning, shell exec with git ref sanitization, JSON extraction)
- `agents/AGENTS.md` — base review instructions loaded by Pi
- `skills/{project}/AGENTS.md` — per-project review instructions
- `tools/context7-fetch.ts` — CLI wrapper for manual Context7 lookups
- `sessions/` — Pi session files (gitignored, runtime)
- `workspaces/` — bare clones and per-MR worktrees (gitignored, runtime)
- `fixtures/` — recorded webhook payloads for testing (gitignored)
- `drizzle/` — generated database migrations

## Config

Project configuration lives in `mend.yml` (gitignored). See `mend.example.yml` for the template. Secrets live in `.env`. The config supports multiple projects, each with: GitLab connection, trigger mode (`ready`/`all`; `label` is schema-valid but currently not executed), review LLM model and thinking level, intent classifier settings, and feature flags.

## Commands

```bash
bun run dev            # Start with watch mode
bun run start          # Start server
bun run test           # Run Mend-owned tests only
bun run test:broad     # Run all discovered tests (including workspaces)
bun run typecheck      # Type check
bun run format         # Check formatting
bun run format:write   # Apply formatting
bun run lint           # Run all lint/dependency checks
bun run check          # Format check, lint, typecheck, and tests
bun run check:agent    # Fast per-file agent check: bun run check:agent <file>
bun run review         # Diff-level review scan before readiness/MR work
bun run replay         # Replay a review (by MR IID or run ID) or run benchmarks
bun run runs           # List review runs
bun run context7-fetch # Manual Context7 documentation lookup
bun run db:generate    # Generate Drizzle migrations
bun run db:migrate     # Run migrations
bun run db:studio      # Open Drizzle Studio
```

Benchmark fixtures: record webhook payloads under `fixtures/webhooks/` and run them through `bun run replay --benchmark <config.json>`. Put expectation files under `fixtures/expectations/<case-name>.json`, or set `expectationPath` in the benchmark case. Expectations should list known `expectedFindings`, `forbiddenFindings`, and optional `expectedResolutionVerdicts`; use `--json` for machine-readable benchmark output.

## Deployment

Deployment runbooks live in the untracked `private/runbooks/` directory (not part of this repository).

## Skills

Project skills are managed through `skillbook`. Canonical project copies live in `.skillbook/skills/` and are synced to the active harnesses.

- Use `skillbook status --project .` before broad skill changes.
- Install relevant shared skills with `skillbook install <id> --project .`.
- Edit project-specific skill content in `.skillbook/skills/<id>/SKILL.md`.
- After skill changes, sync the harnesses currently used for this repo:
  - `skillbook harness sync --project . --id codex --force`
  - `skillbook harness sync --project . --id cursor --force`
  - `skillbook harness sync --project . --id opencode --force`
  - `skillbook harness sync --project . --id pi --force`
- If a shared skill is stale or too product-specific, adapt the project copy instead of importing irrelevant rules.

Current core skills:

- `beads` — issue tracking with bd
- `coding-general` — general implementation practices
- `coding-typescript` — TypeScript formatting and typing patterns
- `git` — git safety and workflow
- `skillbook` — skill installation and harness sync workflow
- `branch-review` — readiness and pre-MR checks
- `code-review-general` — review checklist
- `gitlab-mr-review` — GitLab MR review workflow
- `typescript-cli` — CLI script conventions

## Living Spec

This project uses a Living Spec — a structured domain knowledge base in `.spec/`.
Before implementing any feature or behavior change:

1. Read `.spec/SPEC.md` for the full meta-model and workflow instructions
2. Read `.spec/INDEX.md` for the current graph of all defined primitives
3. Identify the Feature you are implementing and traverse its dependencies
4. If any referenced primitive is missing or incomplete — stop and ask, do not guess
5. Propose spec updates and wait for confirmation before writing any code

When reviewing code, verify that implementation matches the spec (flows, invariants, rules)
and that no undocumented behavior exists without a corresponding primitive.

Use the `lore` CLI to query and update the spec. See `.spec/SPEC.md` for the full command reference.

## Rules

- **No barrel exports.** Import directly from the source file instead of index.ts barrel files. This makes dependencies explicit and avoids circular import issues.
- **No speculative code.** Only add code, config, types, or schemas that are used right now. If nothing imports it or calls it, it doesn't belong yet. Build things when they're needed, not before.
- **No comments in code.** The code should be self-explanatory through clear naming and structure. No inline comments, no block comments, no section dividers. TODOs referencing a ticket ID are the only exception.
- **No lint disable or rule weakening without approval.** If a boundary, dependency, or style rule fires and the clean fix is not obvious, stop and ask. Do not add disables, exclusions, or config weakening to make a gate pass.
- **Verify facts before coding against external tools.** For Mastra, Codex, GitLab, Context7, Drizzle, and Bun behavior, check installed source, official docs, or command help before relying on memory.
- **Keep boundaries explicit.** Webhook handlers parse and route events; Mastra workflow steps orchestrate review work; agent harnesses only run coding agents; Git provider adapters own provider API details; DB modules own persistence; posting safety belongs in the post/publish layer.
- **New MR review behavior needs tests.** Any change to review execution, queueing, posting, thread handling, memory, diff-base resolution, or harness behavior should add or update focused tests. If tests are not practical, state why before proceeding.

## Verification

- After editing code, run `bun run check:agent <changed-file>` for each touched TypeScript/JavaScript file, or an equivalent narrower command that covers the same file.
- During implementation, run the narrowest focused test or typecheck that covers the change.
- Before declaring work ready for MR/review, run:
  - `bun run review`
  - `bun run check`
- If a full gate fails because of existing unrelated worktree debt, report the failure and keep the new change scoped.
