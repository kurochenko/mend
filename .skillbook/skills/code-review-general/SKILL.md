---
name: code-review-general
description: General code review checklist for Mend changes. Use when reviewing any branch, diff, or MR.
license: MIT
compatibility: codex, cursor, opencode, pi, claude-code
metadata:
  audience: developers
  workflow: review
---

# Code Review General

Default to reviewing incremental changes only unless asked otherwise.

## Priorities

Find bugs, safety regressions, data integrity problems, missing tests, and unclear ownership. Do not invent style findings without a project rule.

## Checklist

### Correctness

- Behavior matches the request, Beads ticket, and Living Spec primitives when present.
- Edge cases and error paths are handled.
- State transitions are explicit and idempotent where needed.
- Update reviews, previous-context lookup, and diff-base resolution remain correct.

### Safety

- No secrets, raw webhook payloads, provider tokens, stack traces, or private data are logged or exposed.
- GitLab draft-note safety is preserved.
- Dry-run mode does not mutate provider state.
- Tests do not call live GitLab, live AI agents, or paid external services by default.

### Architecture

- Webhook handlers parse and route provider events only.
- Mastra workflow steps have clear setup/review/post ownership.
- Agent harnesses only invoke coding agents and return structured results.
- Git provider adapters own provider transport and mapping.
- DB modules own persistence and state transitions.
- Shared utilities do not depend upward on server, workflow, provider, or harness modules.

### Tests

- New review behavior has focused tests.
- Queue, diff-base, post/publish, thread, memory, and harness changes cover success and failure paths.
- Tests assert behavior and observable state, not implementation trivia.

## Output

Lead with findings ordered by severity. If no issues are found, say so clearly and mention residual verification risk.

Use:

```markdown
### Critical Issues

- [ ] [file:line] Problem, impact, and suggested fix.

### Improvements

- [ ] [file:line] Risk or maintainability issue and suggested fix.

### Open Questions

- Ambiguity that affects correctness.

### Summary

Brief assessment and verification notes.
```
