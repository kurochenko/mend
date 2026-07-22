---
name: gitlab-mr-review
description: Reviews GitLab merge requests using Mend's structured review expectations. Use when an MR number or GitLab MR link is provided.
license: MIT
compatibility: codex, cursor, opencode, pi, claude-code
metadata:
  audience: developers
  workflow: review
---

# GitLab MR Review

Use this when reviewing GitLab merge requests manually or through an agent harness.

## Inputs

Accept an MR IID, URL, branch, or recorded Mend review run. If the target is ambiguous, ask for the project key and MR IID.

## Review Workflow

1. Read `AGENTS.md`, `.spec/SPEC.md`, and `.spec/INDEX.md`.
2. Identify whether the MR affects review lifecycle, Git provider behavior, DB state, queueing, memory, thread handling, prompt/schema behavior, or deployment tooling.
3. Inspect the diff and relevant unchanged context.
4. Check existing MR discussions when available. Do not duplicate unresolved feedback; reference it.
5. Verify behavior against the Living Spec when primitives exist. If behavior exists without a matching primitive, call that out.
6. Prioritize correctness, data safety, posting safety, deterministic tests, and maintainability over style.

## Mend-Specific Checklist

- Review runs must be idempotent per MR/SHA where configured.
- Update reviews must use the correct diff base and previous review context.
- Review agents must inspect all changed in-scope files or fail deterministically.
- Review output must parse against the expected schema before posting.
- Posting must not publish someone else's pre-existing drafts.
- Dry-run mode must not mutate GitLab state.
- Status notes must remain persistent and safe to update/recreate.
- Thread replies and memory extraction must be idempotent and scoped.
- Tests must not call live GitLab or live AI by default.

## Output

Lead with findings, ordered by severity. If no issues are found, say that directly and mention any residual test or spec gaps.

Use concise findings with file and line references where possible:

```markdown
### Critical Issues

- [ ] [file:line] Problem and impact. Suggested fix.

### Improvements

- [ ] [file:line] Risk or maintainability issue. Suggested fix.

### Open Questions

- Ambiguity that affects correctness.

### Summary

Brief assessment and verification notes.
```
