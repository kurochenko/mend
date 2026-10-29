# Mend

Autonomous agentic system for MR/PR code review. Triggered from GitLab or GitHub webhooks. Uses Mastra for workflow orchestration and a selectable coding-agent harness for review execution.

## Stack

Bun, TypeScript, Hono, Mastra, Codex CLI, Pi (`@earendil-works/pi-coding-agent`), OpenCode, Drizzle, Postgres, Zod, Context7

## Architecture

Three-step Mastra workflow: **setup** (clone/worktree) → **review** (selectable coding-agent harness) → **post** (provider publish: GitLab draft notes, GitHub pending review).

Git hosting is pluggable behind the `ReviewProvider` port (`src/integrations/provider/client.ts`), selected per project via `platform: gitlab | github`. Publishing is an intent-level port operation (`publishReviewBatch`): the GitLab adapter runs the draft-note create/bulk-publish choreography; the GitHub adapter posts one atomic PR review plus a summary issue comment. GitHub thread replies/resolution go through GraphQL; general GitHub PR comments are pseudo-threads (`note_<id>`) that cannot be resolved (parity limitation).

- Mastra owns the workflow: webhook routing, worktree lifecycle, run logging, workflow state.
- The configured review harness (`pi`, `codex`, or `opencode`) owns the review: reads code, inspects changed files where supported, and produces structured findings.
- Every review uses one system prompt (`src/mastra/review/prompt-templates.ts`); there is no intent classifier or per-intent template. Project-specific rules come from the reviewed repository's own `AGENTS.md`, which the reviewer is told to read.
- Reviews run in **initial** or **update** mode. Update mode resolves the diff base by trying candidates in order: previous reviewed SHA → `start_sha` → `base_sha` → target branch (`refs/remotes/origin/<target>` first), fetching missing `start_sha`/`base_sha` commits first and retrying after an authenticated refetch. The bare clone tracks `+refs/heads/*:refs/remotes/origin/*`.
- File inspection is enforced with retry from harness session diagnostics where available. If any files are missed after the first pass, a retry prompt lists the missing files explicitly; remaining gaps are recorded as warnings. Harnesses that cannot report inspected files (OpenCode) skip enforcement with a warning.
- Reviews are posted atomically per provider: GitLab draft notes bulk-published after all notes are created; GitHub inline comments in a single review submission. Before publishing, GitLab drafts that the bot authored with Mend markers (left by an interrupted earlier run) are deleted; any other pre-existing draft (other author or no Mend marker) blocks publishing. Inline positions use the reviewed commit's diff refs, falling back to general discussions when GitLab has no MR version for that commit. The summary note is the last provider write of a review (after inline comments, finding discussions, persistence, and thread resolutions), created without retries and reconciled by run marker, so a failed post leaves no summary to duplicate on retry.
- A DB-backed queue (`mr_review_queue`) with in-process workers deduplicates concurrent reviews per MR (latest-wins: a push with a new SHA aborts the running review's harness processes so the newest commit is reviewed next; the post step is never interrupted) with SHA-level dedup (skips if the exact SHA was already reviewed successfully). Updates a persistent MR status note (`queued`/`running`/`completed`/`failed`/`no_change`).
- On startup, orphaned `running` review runs are marked as `failed`.
- Dry run mode (`review.flags.dry_run`) skips all provider posting (including the status note and note-event replies); logs draft note bodies to stdout. Dry-run runs do not count for SHA dedup or as the previous reviewed run.
- `service-control drain` persists across restarts; Mend's own shutdown stops claiming work in memory only. Run `service-control resume` to leave a drain. Operator drains record `drained_by = 'operator'`; on startup Mend clears any `draining` row without an owner (left by older versions' shutdowns).
- An evals dashboard at `/evals` renders review run history with filtering by project. `/evals` and `/improvements` require `DASHBOARD_TOKEN` (HTTP Basic password or Bearer) and return 404 when it is unset (`src/server/dashboard-auth.ts`). Mastra's HTTP API is not mounted.
- Reviewed code and commenters are untrusted. Pi runs with `projectTrusted: false`, no repo extensions/skills/prompts, and read-only tools confined to the worktree (`src/agents/pi-read-only-tools.ts`). OpenCode runs with project config disabled and edit/bash/webfetch denied. Codex runs with a `mend-review` permission profile: filesystem denied except minimal system paths and read access to the worktree, its bare clone (git common dir, so `git` works in the worktree), and the Codex install, no network (`src/agents/codex-harness.ts`). When a Context7 key is configured, Codex and OpenCode get only the `context7_lookup` tool from Mend's own MCP server, launched from the Mend root with `--no-env-file` so the reviewed repo's `bunfig.toml`/`.env` are never loaded; the key reaches only that server, not the agent's shell. Repo dependency-cruiser config is read from `.dependency-cruiser.json` only.

Mend is a reviewer only: it never edits or pushes code and never executes the reviewed repository's code. Slack integration, label-triggered reviews, and suspend/resume for reply watching are not built yet. MR note webhooks are processed for thread replies and memory.

## Key Directories

- `src/index.ts` — entry point: boots Mastra, Hono server, webhook routes
- `src/config.ts` — loads and validates `mend.yml` project config (Zod schemas)
- `src/server/` — GitLab and GitHub webhook handlers (`gitlab-webhook.ts`, `github-webhook.ts`, neutral event types in `webhook-events.ts`), MR review queue, evals dashboard
- `src/server/webhook-auth.ts`, `webhook-dispatch.ts`, `review-trigger.ts`, `webhook-recording.ts` — shared webhook signature checks, neutral event dispatch (review enqueue / note processing), trigger-mode policy, and fixture recording used by both provider routes
- `src/server/status-note-body.ts` — persistent MR status note rendering
- `src/server/status-note-sync.ts` — persistent MR status note sync (non-throwing provider note upsert)
- `src/server/review-context.ts` — previous run lookup and SHA-level dedup helpers for update reviews
- `src/mastra/` — Mastra instance, workflow definition, steps (setup, review, post)
- `src/mastra/workflows/` — workflow definitions (currently `mr-review.ts`)
- `src/mastra/run-mr-review.ts` — workflow execution wrapper with run persistence and failure handling
- `src/mastra/review/` — prompt construction, output schema, context package, diff base resolution, publish plan/executor, formatting, inspection enforcement, diagnostics, eval scoring
- `src/mastra/steps/` — the three workflow steps (setup, review, post)
- `src/agents/` — coding-agent harness adapters and shared harness contract (`pi`, `codex`, `opencode`)
- `src/integrations/provider/` — provider-neutral `ReviewProvider` port, neutral types, and the GitLab/GitHub adapter factories
- `src/integrations/gitlab/` — GitLab REST API functions (MR details, draft notes, note/discussion CRUD)
- `src/integrations/github/` — GitHub REST + GraphQL functions (PR details, issue comments, review threads, pending-review publish, reactions)
- `src/integrations/repo.ts` — bare clone management, worktree creation/cleanup
- `src/integrations/repo-remote.ts` — authenticated fetches, clone fetch refspec, ensuring commits exist locally
- `src/integrations/context7.ts` — Context7 documentation lookup (registered as a Pi tool; exposed to Codex and OpenCode through the stdio MCP server `src/agents/context7-mcp-server.ts`)
- `src/db/` — Drizzle schema (`review_runs` table), DB client, run CRUD
- `src/cli/` — replay and runs CLI tools
- `src/lib/` — shared utilities (diff parser for inline comment positioning, shell exec with git ref sanitization, JSON extraction)
- `tools/context7-fetch.ts` — CLI wrapper for manual Context7 lookups
- `sessions/` — Pi session files (gitignored, runtime)
- `workspaces/` — bare clones and per-MR worktrees (gitignored, runtime)
- `fixtures/` — recorded webhook payloads for testing (gitignored)
- `drizzle/` — generated database migrations

## Config

Project configuration lives in `mend.yml` (gitignored). See `mend.example.yml` for the template. Secrets live in `.env`. The config supports multiple projects, each with: git host connection (`platform: gitlab` with `project_id`, or `platform: github` with `repo: owner/name`), trigger mode (`ready`/`all`; `label` is schema-valid but currently not executed), review LLM model and thinking level, and feature flags. Removed settings (`review.fix`, `review.triage`, `review.intent`, `review.template`, `flags.prompt_templates_v2`, `flags.schema_v2`) are ignored with a startup warning.

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

Benchmarks: `bun run replay --benchmark <config.json>` re-reviews live MRs (cases name project, MR number, optional commit) in initial mode. Put expectation files under `fixtures/expectations/<case-name>.json`, or set `expectationPath` in the benchmark case. Expectations list known `expectedFindings`, `forbiddenFindings`, and count/category checks; `expectedResolutionVerdicts` is rejected because benchmark runs have no previous review. All expectations are validated before any review runs; `--json` writes only the report to stdout; the process exits 1 if any case fails.

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
