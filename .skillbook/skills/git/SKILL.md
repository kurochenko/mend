---
name: git
description: General git safety and workflow guidance for branches, commits, rebases, and merges. Use when operating on git history.
license: MIT
compatibility: codex, cursor, opencode, pi, claude-code
metadata:
  audience: developers
  workflow: tooling
---

# Git

Project-agnostic rules for safe, predictable git operations.

## When to Use

- Creating branches or commits
- Rebasing, merging, or resolving conflicts
- Preparing changes for review or release

## Safety Rules

- Never lose uncommitted work. Use `git status`, then stash or commit before risky ops.
- Do not push without explicit user consent.
- Avoid destructive commands (`reset --hard`, `checkout --`, force push) unless user requests.
- Do not commit secrets or local-only files.
- If unsure, ask rather than guessing.

## Workflow

### Branching

- Start from the default branch
- Pull latest before branching
- Keep scope focused to a single change
- Use prefixes: `feat/`, `fix/`, `chore/`, `docs/`

### Committing

- Review `git diff` before staging
- Stage only relevant files
- Write concise, imperative messages
- Use conventional commits: `feat:`, `fix:`, `perf:`, `refactor:`, `docs:`, `chore:`, `test:`, `ci:`
- If the change has a Beads ticket, include the id in the subject: `feat: [MEND-c8t] add quality gates`
- Prefer multiple small commits over one noisy commit

### Merge Requests

- Use the same Conventional Commit subject format for MR titles, including the Beads ticket id when applicable.
- Write merge request descriptions from a real multiline file or here-doc.
- Do not pass descriptions with escaped newline text such as `\n`; GitLab will render that literally.
- Before creating or updating a merge request, preview the exact description text that will be sent.
- Use this structure by default:

```markdown
## Summary

- One focused bullet for the behavior change.
- One focused bullet for the user or system impact.

## Verification

- `command that passed`
- `command that failed or was skipped` with the reason
```

### Rebasing

- Ensure a clean working tree (stash if needed)
- Fetch before rebase
- Rebase onto the latest default branch
- If conflicts occur, stop and ask for resolution strategy
- After rebase, verify the working tree and run targeted tests if needed
- Report changes and wait for user approval before any push

## Conflict Handling

- Show conflicted files and the relevant hunks
- Ask which side to keep when logic is ambiguous
- Do not assume intent on business logic changes

## Recovery

- Abort a rebase: `git rebase --abort`
- Recover lost commits: `git reflog` then `git cherry-pick <hash>`
