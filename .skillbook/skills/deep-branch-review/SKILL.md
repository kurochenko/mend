---
name: deep-branch-review
description: >
  Deep branch/MR review workflow for completeness, correctness, bugs, security,
  tests, YAGNI, duplication, architecture boundaries, and folder organization.
  Use when asked to review a branch, MR, PR, diff, or implementation quality,
  especially when external harnesses or parallel reviewers are mentioned.
license: MIT
compatibility: codex, cursor, opencode, pi, claude-code
metadata:
  audience: developers
  workflow: review
---

# Deep Branch Review

Use this skill to review the current branch, merge request, pull request, or diff against the intended base and requirements.

## Natural Language Requests

Accept plain text review requests. The user should not need to remember flag syntax.

Examples:

- "review this yourself"
- "review with cursor and opencode"
- "review with opencode using kimi and codex using gpt-5.5 medium"
- "deep review against main, include security and YAGNI"
- "use cursor composer and Claude too if available"

Extract requested harnesses, models, effort levels, base branch, and emphasis areas from the wording. If no external harness is mentioned, use Codex and subagents when useful. If a harness is named without a model, use that harness's configured/default model.

## Review Contract

Review as a senior owner. Prioritize real risks over style preferences.

Findings must be ordered by severity and must include file/line references when available.

Look for:

- Completeness against the user request, Beads ticket, spec, issue, MR description, and project rules.
- Correctness bugs, edge cases, regressions, data integrity risks, race conditions, and error handling gaps.
- Security issues, unsafe logging, secret exposure, injection, authz/authn mistakes, path/ref abuse, and unsafe external calls.
- Missing, weak, flaky, or misleading tests.
- Dead code, unused exports, unreachable code, speculative scaffolding, and stale TODOs.
- Over-complexity and YAGNI violations.
- Unnecessary duplication; prefer reuse or unification with existing local helpers and patterns.
- File/folder bloat; code should be grouped by domain logic and project rules, not dumped into oversized catch-all modules.
- Dependency direction and call graph shape; avoid upward imports, circular dependencies, and provider details leaking into domain/workflow code.
- Whether the implementation remains readable, composable, and straightforward.

Do not invent style findings. Mention style only when it affects maintainability, correctness, consistency with project rules, or future change cost.

## Default Workflow

1. Identify the base branch or comparison target. If unclear, use the configured upstream default branch.
2. Inspect the diff and changed files.
3. Read the relevant ticket/spec/docs/tests touched by the change.
4. Run the narrowest useful deterministic checks when appropriate.
5. Review architecture and file placement against project rules.
6. Report findings first, ordered by severity.
7. If there are no actionable findings, say that clearly and list residual risks or unverified areas.

## Subagent Policy

When running inside Codex and the review is broad enough to benefit from parallel read-heavy analysis, this skill is explicit permission to use reviewer subagents without asking the user to repeat the fan-out instruction.

Use subagents when at least one of these is true:

- The diff touches multiple domains or more than a few files.
- The user asks for a serious, deep, or high-confidence review.
- The review includes security plus architecture plus test coverage concerns.
- The user names models or asks for multiple reviewers.
- The change is risky, cross-cutting, or intended for merge.

Do not use subagents for tiny, single-file, obvious reviews unless the user explicitly asks.

Recommended subagent split:

- Correctness and security reviewer.
- Tests, verification, and edge-case reviewer.
- Architecture, YAGNI, duplication, and folder-structure reviewer.

Wait for subagents to finish, then synthesize. Do not paste raw subagent logs. Deduplicate findings and keep only actionable issues.

If the user specifies models or effort, apply them to the reviewer subagents when the active Codex surface supports it. If not supported, state the limitation briefly and continue with the available reviewer configuration.

## External Harness Policy

If the user specifies external harnesses such as Cursor, OpenCode, Claude Code, Pi, or Codex CLI, run only the requested harnesses.

Do not assume CLI syntax from memory. For each requested harness:

1. Check whether the CLI is installed.
2. Inspect the CLI help for non-interactive review usage.
3. Run it in read-only/review mode when available.
4. Capture the final findings, not raw logs.
5. Treat external harness output as advisory. Verify any serious claim against the code before reporting it.

If a requested harness is unavailable, not authenticated, or lacks a suitable non-interactive review mode, report that as skipped with the reason.

## Output Format

Use this structure:

```markdown
### Critical Issues

- [ ] [file:line] Problem, impact, and suggested fix.

### High / Medium Issues

- [ ] [file:line] Problem, impact, and suggested fix.

### Improvements

- [ ] [file:line] Maintainability, YAGNI, duplication, or structure issue.

### External Harness Notes

- Harness/model used and whether it found anything independently useful.

### Verification

- Checks run.
- Checks skipped and why.

### Summary

Brief assessment of merge readiness and residual risk.
```

Omit empty sections except `Verification` and `Summary`.

## Review Discipline

- Findings first. Summary last.
- Prefer fewer high-signal findings over exhaustive commentary.
- Do not block on hypothetical rewrites.
- Do not recommend abstractions unless they remove real duplication or boundary risk now.
- Do not suggest moving files unless the current location is concretely hurting ownership, discoverability, or dependency direction.
- Do not trust generated code, comments, or test names as proof. Verify behavior.
