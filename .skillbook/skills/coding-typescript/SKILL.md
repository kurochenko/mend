---
name: coding-typescript
description: TypeScript conventions for Mend: imports, typing discipline, schemas, and functional patterns. Use when writing TS files.
license: MIT
compatibility: codex, cursor, opencode, pi, claude-code
metadata:
  audience: developers
  workflow: implementation
---

# Coding TypeScript

## Formatting

- Biome is the formatting source of truth.
- Single quotes.
- Trailing commas.
- Do not add stylistic ESLint rules that fight the formatter.

## Imports

- External packages first.
- Local imports after, using the `@/` alias.
- No barrel exports; import directly from concrete source files.
- Use `import type` for type-only imports.

```typescript
import { z } from "zod";
import { getDb } from "@/db/client";
import type { ProjectConfig } from "@/config";
```

## Types

- Prefer narrow types and let inference work where clear.
- Prefer `unknown` over `any`.
- Avoid non-null assertions, broad casts, and chained `as unknown as T`.
- Use discriminated unions for stateful values.
- Use exhaustive switches for discriminated unions.
- Reuse upstream types and `z.infer` types instead of redeclaring dependency shapes.
- Name non-trivial function parameters and return values.
- Do not type metadata or provider payloads as open escape hatches. Model known keys, or keep the value `unknown` until parsed.

## Schemas and Boundaries

- Use Zod at HTTP, CLI, file, webhook, workflow, and external-provider boundaries.
- The inferred type travels inward; do not scatter `parse` calls through business logic.
- Use `safeParse` for unknown external output where controlled errors matter.
- Schema defaults must be literals or domain constants, not runtime config or request state.
- Required identifiers must not have silent schema defaults.

## Functions

- Use arrow functions for new utilities unless a library convention requires `function`.
- Keep side effects at the edges.
- Prefer immutable updates.
- Use early returns to reduce nesting.
- Imperative loops are allowed when clearer than array chaining.
