# Living System Specification

You are working with a **Living Spec** — a structured knowledge base that describes the domain, behavior, integrations, and design decisions of this project. Read this file completely before writing any code.

## Purpose

This spec is the precondition for coding, not a post-hoc artifact. Before implementing anything:

1. Identify which **Feature** you are working on
2. Traverse its graph to collect all referenced primitives
3. Run the completeness check (described below)
4. If there are gaps — **stop and ask** before writing code

---

## Meta-Model

### Primitives

The spec is composed of typed files. Each file has YAML frontmatter (the structured part) and a markdown body (the prose part). One file per primitive, stored in the corresponding folder.

| Type | Folder | What it captures |
|---|---|---|
| **Term** | `terms/` | A named domain concept with an unambiguous definition scoped to one bounded context. Everything else references Terms. Entities, value objects, aggregates, roles, statuses, metrics — if it needs a shared meaning, it is a Term. |
| **Invariant** | `invariants/` | A condition that must hold true at all times with zero exceptions. Violating an invariant is a defect. Invariants are never configurable. |
| **Rule** | `rules/` | A configurable business policy. Unlike invariants, rules can change through configuration. Violating a rule is a business rejection, not a bug. |
| **Event** | `events/` | A named occurrence that has already happened. Always past tense. Events connect Flows — one Flow emits an Event, another is triggered by it. |
| **Flow** | `flows/` | An ordered sequence of steps achieving a domain outcome. Flows declare inputs, referenced Terms, respected Invariants/Rules, and emitted Events. The unit of behavior. |
| **Contract** | `contracts/` | An interface boundary with an external system. Declares: what we send, what we receive, field mappings to our Terms, and failure modes. |
| **Decision** | `decisions/` | A design choice with context, rationale, alternatives considered, and consequences. |
| **Feature** | `features/` | A named capability that declares which primitives it requires. The entry point for implementation and completeness checking. |

### Edges

Six typed, directional relationships. Declared in the `links` section of each file's frontmatter.

| Edge | Direction | Meaning |
|---|---|---|
| **depends-on** | any → any | X cannot be defined or function correctly without Y. The primary edge for impact analysis and completeness checking. |
| **constrains** | Invariant\|Rule → Term\|Flow | X imposes a restriction on Y. The implementation of Y must respect X. |
| **includes** | Feature → any; Term → Term | X has Y as a constituent part. Features declare their primitives; composite Terms declare sub-terms. |
| **maps-to** | Term → Term; Contract → Term | X in one context/system corresponds to Y in another. Used at bounded context boundaries and external system interfaces. |
| **emits** | Flow → Event | X produces Y as a result of execution. |
| **triggers** | Event → Flow; Event → Event | X causes Y to begin. |

### Bounded Context

A named domain boundary that scopes the meaning of primitives. Every file carries a `context` field in frontmatter. Context is not a primitive type — it has no file of its own.

When a primitive has a context, that context becomes part of the identity. Shared primitives with no context use `prefix:slug`. Contextual primitives use `context.prefix:slug` (e.g., `billing.term:status`).

A primitive with no context is a **shared concept** available to all contexts (e.g., `term:money`, `term:timestamp`).

Contexts are implicit — created when the first primitive uses one.

**Cross-context edge conventions:**

- `maps-to` crossing contexts → **healthy**. Explicit mapping between projections of the same real-world concept.
- `triggers` crossing contexts → **healthy**. Event-driven integration — the clean seam between contexts.
- `depends-on` crossing contexts → **smell**. Tight coupling. Consider introducing an event or contract at the boundary.
- `constrains` crossing contexts → **smell**. One context imposing rules on another. The constrained context should own its own invariants/rules.
- `includes` crossing contexts → **fine for features** (they naturally span contexts), **smell for terms** (suggests a missing shared kernel).
- `emits` crossing contexts → **should not happen**. A flow and the events it emits belong to the same context.

**Cross-context integration patterns:**

When the graph reveals cross-context coupling, these patterns guide the fix:

1. **Shared Kernel** — concepts that genuinely belong to no single context. Store them without a context prefix (`term:money`, `term:timestamp`). When two contexts define near-identical terms without a `maps-to` edge, consider extracting to a shared concept.

2. **Context Mapping** — same real-world thing, different projections per context. `billing.term:customer` (payment method, tax ID) maps-to `crm.term:customer` (contact history, lifecycle stage). Each context owns its own definition; the `maps-to` edge documents the correspondence. Changes to one should prompt review of the other.

3. **Event-Driven Integration** — the clean seam between contexts. Context A's flow emits an event; context B's flow is triggered by it. No direct `depends-on` across the boundary. When you see cross-context `depends-on`, decomposing into emit/trigger is usually the fix.

4. **Contract Boundary** — integration with external or legacy systems. A `contract` primitive in your context translates the external model into your internal terms via `maps-to` edges. The contract declares what you send, what you receive, and failure modes — keeping the external model's complexity at the boundary.

5. **Smell Detection** — the graph reveals structural problems. High cross-context `depends-on` density between two contexts suggests they may be one context or are missing a shared kernel. Same-slug-different-context pairs without `maps-to` edges suggest accidental duplication. A context with zero cross-context edges is either truly independent or missing integration points.

---

## File Format

Every primitive file follows this structure:

```yaml
---
type: term | invariant | rule | event | flow | contract | decision | feature
name: Human Readable Name
id: kebab-case-slug
context: bounded-context-name
deprecated: true  # optional — only add when marking a primitive as no longer relevant
links:
  - edge: depends-on | constrains | includes | maps-to | emits | triggers
    target: prefix:target-slug  # or context.prefix:target-slug
tags: [optional, grouping, tags]
---

Prose body goes here. Free-form markdown.
```

### Deprecation

There is no status lifecycle. A primitive file exists or it doesn't. If it exists, it's active.

The only flag is `deprecated: true` — a soft delete. It means: this primitive is no longer relevant for new work, but the file stays because other primitives may still link to it and git history references it. The LLM skips deprecated primitives during completeness checks and does not use them for new implementations.

Do not delete primitive files. Deprecate them instead. Deleting breaks link references.

### Naming conventions

- **id** (slug): kebab-case, unique within its (type, context) pair. E.g., `ltv`, `loan-approved`, `max-residential-ltv`
- **qualified id**: `prefix:slug` or `context.prefix:slug`. Each type has a short prefix: `term`, `inv`, `rule`, `evt`, `flow`, `con`, `dec`, `feat`. Shared primitives with no context use `prefix:slug`. Contextual primitives must use `context.prefix:slug`. E.g., `term:ltv`, `billing.term:status`
- **type input**: CLI commands that accept a type accept both the full name (`feature`) and the prefix (`feat`). Frontmatter always stores the full name — prefix resolution is input-only.
- **filename**: `{slug}.md` inside the type folder, or `{context}.{slug}.md` when context is present. E.g., `.spec/terms/ltv.md`, `.spec/terms/billing.status.md`
- **target** in links: the qualified id. Shared primitives use the short form; contextual primitives use the context-qualified form. E.g., `target: term:ltv`, `target: billing.term:status`

---

## How to Use This Spec (LLM Instructions)

### Before implementing a feature

```
1. Read the Feature file for the capability you're implementing
2. Collect: all primitives the Feature includes
3. For each included primitive:
   a. Read the file
   b. Recursively collect its depends-on targets
   c. Collect all Invariants/Rules that constrains it
   d. For Flows: collect emits targets; for Events: collect triggers targets
4. Build the full set of primitives in scope
5. Check: does every referenced id have a corresponding file?
   - YES → you have a complete subgraph. Proceed to implement.
   - NO  → you have gaps. List them and ask the user before writing code.
```

### When you find a gap

A gap is any situation where:
- A `links.target` references an id that has no file
- A Flow references a Term that isn't defined
- An Invariant constrains something, but the constraint parameters are unclear
- You need domain knowledge that isn't captured anywhere in the spec

When you find a gap:
1. **Stop.** Do not guess or infer.
2. Tell the user exactly what's missing and why you need it.
3. Propose a primitive — suggest the type, name, id, and what you think the definition might be.
4. Wait for the user to confirm or correct.
5. Write the file only after confirmation.

### When you propose a spec update

If you discover during implementation that:
- A Term needs a clarified definition
- An Invariant is missing
- A Rule's parameters aren't captured
- A Flow has steps that aren't documented

Then:
1. Finish the immediate coding task if you have enough to proceed safely
2. Propose the update as a specific diff: "I'd add Invariant X with these links because..."
3. Wait for user confirmation before writing to the spec
4. Write the primitive file after confirmation

### Writing linked prose

When writing or editing primitive files:
1. Treat frontmatter `links` as the canonical graph
2. For every linked primitive, add a matching `[[...]]` link in the body prose
3. Put that `[[...]]` link where the concept is actually explained, referenced, or used in the existing prose
4. Prefer wrapping the existing word or phrase in place instead of appending cross-reference boilerplate
5. Do not satisfy link coverage with sections like `Related primitives`, `See also`, or synthetic sentences such as `This flow depends on ...`
6. Only add a new sentence when the linked concept is genuinely missing from the explanation and that addition improves clarity
7. When showing literal wrapper syntax as an example, escape it as `\[\[term:example\]\]` so it is not treated as a live link

After manual spec edits:
1. Rebuild `INDEX.md`
2. Run `lore check` on the affected primitive or feature
3. Fix prose/frontmatter drift by linking the real prose, not by adding boilerplate

### When starting with an existing project (brownfield)

If you're plugging this spec into a project that already has code:
1. Do NOT try to reverse-engineer the entire domain at once
2. Start with the Feature you're currently working on
3. Define only the primitives that Feature needs
4. As you work on more features, the spec grows naturally
5. Each session should leave the spec slightly more complete than it found it

### Deriving tests from the spec

Four primitive types have testable specifications:

**Invariants** declare conditions that must always hold. Test two paths:
- Assert the invariant holds for valid inputs
- Assert violations are rejected with a clear error

**Rules** declare configurable policies. Test boundary values and the default behavior.

**Flows** declare ordered sequences of steps. Test:
- Happy path: all steps execute in the correct order
- Error paths: each failure mode produces the correct outcome

**Contracts** declare interface boundaries with external systems. Test what you send, what you receive, and how failures are handled.

Four types are not directly testable:
- **Terms** — definitions only, nothing to execute
- **Decisions** — rationale, validated implicitly through the code they shape
- **Events** — tested through the flows that emit and trigger them
- **Features** — rollups, verified by testing their constituent primitives

When implementing a feature:
1. Collect its invariants, rules, flows, and contracts — these are your test cases
2. Write the spec primitives first
3. Write tests before implementing
4. Implement until tests pass
5. Never declare implementation complete without passing tests

### Reviewing code against the spec

When reviewing code (yours or others'), check both directions — code against spec and spec against code:

1. **Spec → Code**: For each relevant flow, invariant, and rule in the spec, verify the implementation matches. Are flow steps implemented in the right order? Are invariants actually enforced (not just documented in comments)? Are rule parameters configurable as specified?
2. **Code → Spec**: Look for behaviors in the code that aren't captured in any primitive. Undocumented validation logic, implicit business rules, error handling that constitutes a flow — these are spec gaps. Propose new primitives for them.
3. **Invariant coverage**: Every invariant should have tests for both the holds path and the violation path. If an invariant exists in the spec but has no corresponding test, flag it.
4. **Dead spec**: If a primitive describes behavior that no longer exists in code, it should be deprecated. Stale primitives are worse than missing ones — they actively mislead.
5. **Cross-context hygiene**: Check for direct `depends-on` edges crossing context boundaries. These should typically be decomposed into event-driven integration or contract boundaries.

### CLI Reference

The `lore` CLI manages the spec. All write commands automatically rebuild `.spec/INDEX.md`. All `<ref>` arguments accept both `prefix:slug` and `context.prefix:slug` forms.

**Reading:**

`lore show <ref>` — display a primitive's frontmatter and body

`lore show <ref> --related` — display the primitive plus its connected subgraph (outbound and inbound)

`lore list` — list all primitives

`lore list --type <type>` — filter by type (accepts full name or prefix, e.g. `feature` or `feat`)

`lore list --context <name>` — filter by bounded context

`lore check <ref>` — walk the dependency graph from any primitive, report dead refs, deprecated refs, and prose/frontmatter consistency errors

**Writing:**

`lore add <type> <slug> -n "Name" -b body.md` — create a new primitive (`-b` for body file, or `-b "inline body"`)

`lore add <type> <slug> -n "Name" -c <context> -b body.md` — create a primitive in a specific bounded context

`lore link <source> <edge> <target>` — add a typed edge between two primitives (enforces edge constraints)

`lore unlink <source> <edge> <target>` — remove a typed edge

`lore deprecate <ref>` — mark a primitive as deprecated

`lore rename <ref> <new-slug>` — rename a primitive's slug, rewrite all inbound references

`lore rm <ref>` — delete a primitive (blocked if inbound references exist; use `--force` to override)

`lore reindex` — rebuild INDEX.md from disk (use after manual file edits)

`lore migrate [--confirm <version>]` — apply pending spec-format migrations and generate review guides for manual migrations

**Scaffolding:**

`lore init [--dir <path>]` — create `.spec/` in the target directory

### Query patterns

Three common ways to use the CLI:

**Direct lookup** — "What is LTV?" → `lore show term:ltv`

**Impact analysis** — "What breaks if I change LTV?" → `lore show term:ltv --related`

**Completeness check** — "Do I have everything for Loan Origination?" → `lore check feat:loan-origination`

---

## Index

The file `.spec/INDEX.md` is an auto-maintained flat list of all primitives and their links. It exists so that a single file read gives you the full graph topology without opening every file. It is rebuilt automatically by the lore CLI on every write command.

---

## Principles

1. **Spec before code — no exceptions.** Every change to behavior must start with updating or creating the relevant spec primitives. Propose the changes, get explicit user confirmation, write the primitives, THEN implement. This is the golden rule. Skipping it has three consequences: the spec drifts from reality and loses all value; you may implement something the user disagrees with, wasting effort that must be redone; and worst, incorrect changes may slip past the user's attention entirely. Never write implementation code before the spec is confirmed.
2. **Minimal but complete.** Don't define what you don't need yet. But what you define must be complete enough to implement against without guessing.
3. **The spec grows through use.** Don't populate it proactively. Let implementation pressure reveal what's needed.
4. **Invariants over comments.** If a rule must always hold, put it in an Invariant file — not in a code comment. Code comments get stale. The spec is the source of truth.
5. **One qualified id, one file, one meaning.** No ambiguity. IDs are unique per (type, context). Shared primitives use `prefix:slug`; contextual primitives use `context.prefix:slug` (`term:ltv`, `billing.term:status`). If two contexts use the same word differently, they are two distinct primitives — use `maps-to` only when they represent projections of the same real-world concept.
6. **The graph is the value.** Prose definitions are necessary but not sufficient. The links between primitives are what enable impact analysis, completeness checking, and gap detection.
7. **Exists means active.** No status lifecycle. If a file is in the spec, it's live. If it's no longer relevant, mark it `deprecated: true`. That's the only flag.
