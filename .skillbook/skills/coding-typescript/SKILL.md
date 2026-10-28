---
name: coding-typescript
description: TypeScript conventions for Mend: formatting, imports, typing discipline, absence, dates, and Zod schemas at boundaries. Use when writing TS files.
license: MIT
compatibility: codex, cursor, opencode, pi, claude-code
metadata:
  audience: developers
  workflow: implementation
---

# Coding TypeScript

Tooling enforces the mechanical rules; do not restate or fight them:

- Biome (`biome.json`) owns formatting: 2 spaces, 100 columns, single quotes, no
  semicolons, trailing commas. Run `bun run format:write` or `bun run check:agent <file>`.
- `tsconfig.json`: `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`,
  `noUnusedLocals`/`Parameters`, `noFallthroughCasesInSwitch`, `verbatimModuleSyntax`.
- ESLint (`eslint.config.mjs`) errors on barrel exports and unused vars (prefix
  intentionally unused with `_`), and warns on non-null assertions, missing type-only
  imports, non-exhaustive switches, `||` where `??` fits, missing curly braces, and `==`.
  Warnings count against the `--max-warnings` budget; never raise it.

## Imports

- External packages first, then local imports through `@/` (`@/*` maps to `./src/*`).
- No barrel exports; import from the concrete source file.
- Type-only imports use separate `import type` statements.

```typescript
import { z } from 'zod'
import type { ProjectConfig } from '@/config'
import { getDb } from '@/db/client'
```

## Strictness

- Prefer `unknown` over `any`; keep opaque provider and harness payloads `unknown` until
  parsed.
- Avoid broad casts and chained `as unknown as T`. If a type is wrong, fix the signature or
  parse the boundary.
- Handle `noUncheckedIndexedAccess` results explicitly instead of asserting with `!`.
- Use discriminated unions for stateful values (run status, publish outcome, harness
  result) and exhaustive switches whose `default` passes the value to a `never` check.
- Reuse upstream and `z.infer` types instead of redeclaring dependency shapes.
- Do not type metadata or options as `Record<string, unknown>` or open index signatures.
  Model known keys.

## Named Types

- Name non-trivial parameters and return values; inline types are fine for tiny local
  shapes.
- Group 4+ parameters into a named object type (`max-params` is 4).
- DB, provider, and review functions return named domain types, not broad records or raw
  provider rows.

```typescript
type RecordReviewOutcomeInput = {
  runId: string
  headSha: string
  outcome: ReviewOutcome
}

type RecordReviewOutcome = (input: RecordReviewOutcomeInput) => Promise<ReviewRun>
```

## Schemas and Boundaries

- Use Zod at HTTP, webhook, CLI, file, `mend.yml`, workflow step, harness output, and
  provider boundaries. The inferred type travels inward; do not scatter `parse` through
  domain logic.
- Use `safeParse` for agent and provider output where controlled errors or retries matter.
- Schemas are static contracts: defaults are literals or domain constants, never runtime
  config or request state. Required identifiers have no silent defaults.
- Preserve discriminated unions at workflow and harness outputs; do not flatten failures
  into empty strings or empty arrays.
- Do not use `.default('')` for meaningful absence; prefer `.min(1).optional()` or
  `.nullable()` and render absence at the presentation boundary (status note, dashboard).

## Absence and Defaults

- Preserve absence as `null` or `undefined` at the source; do not coalesce into `''`, `0`,
  or sentinels in domain or DB layers.
- One default has one home: the `config.ts` schema, a named domain constant, or explicit
  input. Do not duplicate the same default in harness, step, and schema.
- Persisted IDs come from the database or the provider where practical; otherwise generate
  them through one named helper for that domain.

## Dates and Durations

- Keep instants as `Date` (DB `timestamp` with time zone) and serialize as ISO 8601 UTC.
  Render UTC in notes, dashboards, and CLI output; never depend on the host time zone or
  `toLocale*`.
- Parse provider timestamps with `parseProviderTimestamp` (`@/lib/timestamps`), which
  returns `null` for missing or invalid values.
- Durations are millisecond numbers with an `Ms` suffix (`timeoutMs`, `durationMs`).
- Add a date library only when real calendar or time zone arithmetic appears.

## Functions

- Use arrow functions for new code unless a library convention requires `function`.
- Keep side effects at the edges; prefer immutable updates and early returns.
- Imperative loops are fine when clearer than array chaining.
