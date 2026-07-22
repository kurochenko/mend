---
name: typescript-cli
description: TypeScript CLI script conventions for Mend. Use when writing or reviewing scripts under src/cli, tools, or scripts.
license: MIT
compatibility: codex, cursor, opencode, pi, claude-code
metadata:
  audience: developers
  workflow: implementation, review
---

# TypeScript CLI

Use this for `src/cli/**`, `tools/**`, and `scripts/**`.

## Rules

- Use Bun commands and APIs where they are already established.
- Keep CLI parsing simple unless a real command surface needs a parser library.
- Validate file, JSON, YAML, and environment input at the boundary.
- Print user-facing CLI output intentionally; do not log raw secrets or provider payloads.
- Exit non-zero for blocking failures.
- Keep reusable business logic outside CLI files so tests can call it directly.
- Add focused tests for parsing, scoring, replay, or review-scan behavior when logic grows beyond trivial glue.

## Verification

Run:

```bash
bun run check:agent <file>
```

For behavior changes, also run the focused CLI command or test that proves the behavior.
