---
name: feature-layout
description: Mend architecture and file placement guidance. Use when adding modules, changing boundaries, or when architecture/dependency lint rules fire.
license: MIT
compatibility: codex, cursor, opencode, pi, claude-code
metadata:
  audience: developers
  workflow: structure
---

# Feature Layout

Mend is a backend agent orchestration system. Keep ownership obvious and dependency direction downward.

## Top-Level Areas

- `src/server/`: Hono routes, webhook intake, queue coordination, status notes, conversation/event handling.
- `src/mastra/workflows/`: workflow graph definitions.
- `src/mastra/steps/`: setup, review, and post workflow steps.
- `src/mastra/review/`: review domain logic: prompts, schema, context, diff-base, inspection, diagnostics, evals, memory shaping.
- `src/agents/`: coding-agent harness adapters. No GitLab posting or DB persistence here.
- `src/git-service/`: provider abstraction and provider implementations.
- `src/db/`: Drizzle schema and persistence helpers.
- `src/integrations/`: shared external integrations that are not Git provider publishing.
- `src/lib/`: low-level pure or infrastructure utilities.
- `src/cli/`, `tools/`, `scripts/`: command-line and maintenance tooling.

## Dependency Direction

```text
server/webhook
  -> queue/run wrapper
    -> Mastra workflow step
      -> review domain + agent harness + provider adapter + db helper
```

Provider adapters should not import server or workflow code. Agent harnesses should not import provider posting or persistence. DB helpers should not orchestrate workflow/provider behavior.

## When Adding Code

- Put provider API details in `src/git-service/<provider>/`.
- Put prompt/schema/review behavior in `src/mastra/review/`.
- Put workflow orchestration in `src/mastra/steps/`.
- Put queue/event intake in `src/server/`.
- Put reusable low-level helpers in `src/lib/`.
- Put test doubles near the tested boundary, not inside production adapters.

If a dependency rule fires and the clean fix is not obvious, stop and ask. Do not disable or weaken the rule.
