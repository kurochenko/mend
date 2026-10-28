---
name: feature-layout
description: Mend architecture and file placement. Use when adding or moving modules, deciding server/workflow/review/harness/provider/db boundaries, splitting large functions, or resolving dependency-cruiser or ESLint size findings.
license: MIT
compatibility: codex, cursor, opencode, pi, claude-code
metadata:
  audience: developers
  workflow: structure
---

# Feature Layout

Mend is a layered backend service. Keep the call graph easy to explain and dependencies
pointing downward:

```text
src/server (webhook, queue, notes)
  -> src/mastra/run-mr-review.ts + src/mastra/workflows
    -> src/mastra/steps (setup, review, post)
      -> src/mastra/review + src/agents + src/integrations + src/db
        -> src/lib
```

## Folder Shape

- `src/server/`: Hono routes, webhook intake and neutral events (`webhook-events.ts`), review
  and fix queues, status notes, thread replies, triage commands, dashboards.
- `src/mastra/workflows/`: workflow graph definitions. `src/mastra/steps/`: setup, review,
  and post orchestration.
- `src/mastra/review/`: review domain: intents, templates, prompts, schemas, context
  package, diff base, inspection, diagnostics, publish plan/executor, memory, `eval/`.
  Sibling domains: `src/mastra/fix/`, `src/mastra/improvements/`.
- `src/agents/`: coding-agent harnesses behind `review-harness.ts`; structured results only.
- `src/integrations/provider/`: the `ReviewProvider` port, neutral types, and per-platform
  adapter factories. `src/integrations/gitlab/` and `src/integrations/github/`: provider
  REST/GraphQL transport. Shared integrations (`repo.ts`, `context7.ts`) sit beside them.
- `src/fix-workspaces/`: isolated fix workspace providers.
- `src/db/`: Drizzle `schema.ts`, `client.ts`, and one persistence module per aggregate.
- `src/lib/`: neutral utilities (diff parsing, exec, JSON extraction, errors, timestamps).
- `src/cli/`, `tools/`, `scripts/`: command-line and maintenance tooling (`typescript-cli`).

Topology defines ownership and direction, not mandatory scaffolding. Add a folder only when
three or more files share a real subdomain, and drop the subdomain prefix inside it
(`integrations/github/threads.ts`, not `github-threads.ts`). Do not create empty or one-file
layers in anticipation of growth. Existing flat prefixes (`src/server/review-*.ts`) are
established; do not reshuffle them during feature work.

## Locality and growth

- Keep behavior close to the workflow that owns it until reuse or a separate reason to
  change is demonstrated.
- A local change should mostly touch its owner and direct consumers. If it needs edits across
  server, steps, harnesses, and providers, treat that as evidence the contract is too broad.
- New provider behavior goes behind a `ReviewProvider` operation implemented by both
  adapters. Platform branching belongs in webhook intake and adapter selection, not in
  steps or review logic.
- Keep tests and test doubles beside the tested module (`*.test.ts`); fakes never live in
  production adapters. End-to-end fakes live in `tests/e2e/`.
- Propose topology changes separately when the layout repeatedly prevents locality.

## Boundary Rules

`.dependency-cruiser.cjs` (`bun run lint:depcruise`) enforces:

- no circular dependencies;
- `src/agents/` must not import `integrations/gitlab`, `integrations/repo`, `mastra/steps`,
  `server`, or `db`;
- `src/integrations/` must not import `mastra`, `server`, or `db`;
- `src/db/` must not import `mastra` or `server`;
- `src/lib/` must not import `server`, `mastra`, `db`, `integrations`, or `agents`.

Beyond the enforced rules: provider adapters own request parameters, pagination, retry and
error classification, and raw payload parsing; DB modules do persistence and row mapping and
do not orchestrate; posting safety lives in the post/publish layer. Do not leak Drizzle rows or
raw provider payloads upward. Use `@/` imports; relative imports only for same-folder files.

Investigate a boundary finding against the owning layer. Ask only when competing
requirements remain unresolved, and never weaken a rule or add an exclusion to pass.

## Decomposition

- ESLint warns at `max-lines-per-function` 90, `complexity` 12, `max-params` 4, and
  `max-depth` 4 (tests, `scripts/`, and `tools/` are exempt); `lint:eslint` fails past its
  `--max-warnings` budget. Split along a real seam; never raise the budget or add a disable.
- Split files with several unrelated responsibilities even though no file-length limit is
  enforced.
- Group 4+ related parameters into a named object type.
- Extract a shared capability on the second real consumer, not the first.
- No barrel `index.ts` files (`mend/no-barrel-export`); `knip` flags unused exports and files.
- Keep decision logic in pure functions so most coverage needs no mocks (`testing-unit`).

## Decision Tree

1. Webhook parsing, routing, queue, or status note -> `src/server/`.
2. Workflow step orchestration -> `src/mastra/steps/`; graph wiring -> `src/mastra/workflows/`.
3. Prompt, schema, diff-base, inspection, publish planning, or memory -> `src/mastra/review/`.
4. Running a coding agent -> `src/agents/<name>-harness.ts`.
5. Provider-neutral operation -> `src/integrations/provider/`; GitLab or GitHub API detail ->
   `src/integrations/gitlab/` or `src/integrations/github/`.
6. Persistence -> `src/db/` (`coding-drizzle-postgres`).
7. Pure helper with no application dependency and a second consumer -> `src/lib/`.
8. Operator command -> `src/cli/` with logic kept importable.
