---
name: git
description: Safe Git and GitLab workflow for Mend branches, commits, rebases, merges, and merge requests, including commit subject and MR title format. Use when operating on Git history or delivery state, or when writing a commit subject or MR title.
license: MIT
compatibility: codex, cursor, opencode, pi, claude-code
metadata:
  audience: developers
  workflow: tooling
---

# Git

## Safety

- Inspect `git status` and the relevant diff before changing history or staging.
- Preserve unrelated and uncommitted work. To set work aside, prefer a temporary
  WIP commit. Never use bare `git stash` or `git stash pop`: the stash stack is
  shared across worktrees and sessions. If a stash is unavoidable, use
  `git stash push -u -m "<unique-tag>"`, record its SHA from
  `git stash list --format='%H %gs'`, restore with `git stash apply <sha>`, then
  drop the entry after re-finding it by tag.
- Never use destructive checkout/reset or force push without explicit approval.
- Do not stage, commit, push, or create an MR unless the user requested that action.
- `origin` is the GitLab remote. The `github` remote is the public mirror; do not
  push to it unless asked. Never bypass the pre-push hook (`bun run check` and
  `scripts/guard-public.sh`).
- Never commit secrets, `.env`, `mend.yml`, `private/`, or runtime directories
  (`sessions/`, `workspaces/`, recorded payloads in `fixtures/webhooks/`).

## Branches and commits

- Start new work from `origin/main` after fetching, when the checkout is clean and
  the task permits switching branches.
- Use a short kebab-case branch with a type prefix: `fix/status-note-sync`.
- Keep one coherent change per branch and MR.
- Stage only task-owned files after reviewing the diff.

## Titles

Commit subjects and MR titles share one format:

```text
<type>(optional-scope): [MEND-xxx] clause
```

Types: `feat`, `fix`, `perf`, `refactor`, `docs`, `chore`, `test`, `ci`. Use
`refactor` for structure or ownership changes that intentionally preserve behavior.
Scope is optional lowercase kebab-case naming the area (`queue`, `github`).
Include the Beads id in brackets right after the colon when the work has a ticket;
omit it otherwise and never create a ticket just to fill the title. No trailing
period.

The clause is lowercase imperative and names the durable change, not an empty
outcome (`fix X`, `update X`). Put the mechanism in the clause when it is the
change; leave endpoint and patch details to the MR body. Examples from history:

- `fix: exclude benchmark replays from review run history`
- `fix: reconcile completed GitHub reviews`
- `feat: [MEND-c8t] add quality gates`

## Merge requests

Use the GitLab CLI (`glab`):

1. Check for an existing MR first:
   `glab mr list --source-branch <branch>`.
2. Write the description as real multiline Markdown to a file or here-doc; never
   pass escaped `\n` text. Preview the exact title and description before sending.
3. Create with explicit branches:
   `glab mr create --source-branch <branch> --target-branch main --title "<title>" --description "$(cat /tmp/mr-description.md)"`.
4. Verify with `glab mr view <iid>`: target branch, title,
   description rendering, and latest head SHA.

The description covers the behavior change, user or system value, and durable
decisions. Keep command logs out unless requested. When a step must run right
after deploy (migration, backfill), add an **After deploy** section with the exact
command, environment, and ordering constraint. `glab api` here does not support
`--jq`; pipe JSON to local tooling instead.

Push a settled, validated revision rather than after each edit. Collect and triage
review findings before editing, then push grouped repairs. No empty retrigger
commits. Do not rewrite published history without approval.

## Rebasing and integration

- Rebase only from a clean tree, after `git fetch origin`, onto `origin/main`.
- Update the branch when a conflict, dependency, or changed target behavior
  requires it; an unrelated target advance alone does not.
- After rebasing, inspect the diff and rerun affected checks. Report and wait for
  approval before force-pushing a rewritten branch.

## Conflicts and recovery

- Resolve mechanical conflicts from current code and documented ownership.
- Ask when both sides encode plausible but incompatible behavior.
- Prefer `git rebase --abort` or `git merge --abort` over improvised recovery.
- Use `git reflog` to locate recoverable commits and `git cherry-pick <sha>` to
  restore them; do not reset destructively by default.
