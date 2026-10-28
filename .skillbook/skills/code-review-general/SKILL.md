---
name: code-review-general
description: Review Mend changes for actionable correctness, posting-safety, data-integrity, architecture, test, and maintainability regressions. Use for read-only reviews of a diff, branch, or MR.
license: MIT
compatibility: codex, cursor, opencode, pi, claude-code
metadata:
  audience: developers
  workflow: review
---

# Code Review General

Review is read-only unless fixes are requested. Review the requested revision and
its actual diff against the intended base (incremental changes only unless asked
otherwise), using the request, Beads ticket, Living Spec primitives, and
participating code to recover intent. Green checks or another agent's report are
supporting evidence, not a correctness verdict.

## Scope and depth

Use a standard focused review for ordinary changes. Use deep review when asked, or
when a change carries substantial risk or coupling across posting, queueing,
diff-base resolution, provider adapters, harnesses, or persistence. A
merge-readiness request alone does not require multiple reviewers for a small change.

Load only affected specialist guidance:

| Changed surface | Owner |
| --- | --- |
| Module placement/dependency direction | `feature-layout` |
| TypeScript types and contracts | `coding-typescript` |
| Schema, queries, migrations | `coding-drizzle-postgres` |
| Tests, mocks, fixtures | `testing-unit` |
| CLI tools (`src/cli/`, `tools/`, `scripts/`) | `typescript-cli` |
| Review of a GitLab MR by IID or link | `gitlab-mr-review` |
| Multi-harness or parallel-reviewer review | `deep-branch-review` |

Trace changed behavior, affected callers, and realistic failure paths. Deep review
adds separate passes over the affected risk boundaries and their seams. Resolve
conflicting evidence and verify each concrete finding.

For each changed failure path ask:

- Where does this failure surface: run status, status note, logs?
- If the process dies midway, what moves the `running` run or queue row to a
  terminal state? Startup marks orphaned `running` review runs `failed`; new
  states need equivalent recovery.
- Is the original cause preserved, without leaking tokens or raw payloads?

## Deep-mode review matrix

Before reporting findings in deep mode, classify every dimension as:

- **Affected** — inspect it and record the evidence.
- **Not applicable** — state briefly why the change cannot affect it.
- **Gap** — explain what could not be verified and how that limits the verdict.

Do not silently skip a dimension. The matrix guides inspection; it does not lower
the finding threshold.

### Intent and affected population

- Identify requested behavior, invariants, non-goals, and accepted tradeoffs.
- Identify affected projects (GitLab and GitHub), existing `review_runs` and queue
  rows, open MRs with prior reviews, and in-flight runs at deploy time.
- Distinguish new behavior from migration and compatibility behavior.

### Architecture and ownership

- Webhook handlers parse and route events only; no posting, recovery, or
  persistence orchestration.
- Workflow steps keep setup/review/post ownership. Posting safety stays in the
  post/publish layer.
- Harness adapters (`pi`, `codex`, `opencode`) only run coding agents and return
  structured results; they know nothing of providers, status notes, or the DB.
- Provider adapters own transport, pagination, error classification, and mapping.
  Provider payload shapes must not leak into review or workflow logic.
- DB modules own persistence and state transitions; shared utilities do not
  import upward.
- Check for policy with more than one source of truth, and for GitLab/GitHub or
  per-harness variants that duplicate behavior and can drift. Prefer a shared core
  with narrow adapters; reject speculative abstractions without a current caller.

### Execution and data flow

Trace each changed entry point:

`webhook/CLI -> queue -> workflow step -> harness/provider/DB -> run result -> status note/post`

- Identify validation and type-loss boundaries, and process, network, and harness
  subprocess boundaries.
- Trace success, empty diff, rejection, retry, partial failure, superseded, and
  terminal paths that apply.
- Inspect affected callers and consumers, not only the changed implementation.

### Contracts and type safety

- Parse webhook, provider, harness output, and persisted data with Zod rather
  than casts. Review output schemas and prompt contracts stay deterministic.
- Preserve identity-to-payload relationships with discriminated unions or
  exhaustive dispatch; flag stringly typed protocols and unsafe defaults.
- Contract changes must keep older persisted runs and findings readable or fail safely.

### State, concurrency, and side effects

- Queue dedup keeps latest-wins per MR and SHA-level skip of already reviewed
  SHAs. Check concurrent webhooks, superseded runs, and stale completions.
- Update reviews resolve the diff base in order (previous reviewed SHA →
  `start_sha` → `base_sha` → target branch) with fetch-and-retry; force pushes and
  missing SHAs must not produce a wrong or empty diff.
- Publishing stays atomic per provider and refuses foreign pre-existing drafts
  (GitLab draft notes, GitHub pending reviews). Retries must reconcile, not
  duplicate, notes and threads.
- Dry run never mutates provider state. Status-note sync never throws into the run.
- Related DB writes are transactional, with provider I/O outside the transaction.

### Framework and library fit

- Use the owning primitive (Mastra workflow state, Drizzle, Hono, Zod) instead of
  custom replacements that bypass its guarantees.
- For version-sensitive behavior of Mastra, Codex, Pi, OpenCode, GitLab, GitHub,
  Drizzle, or Bun, verify installed source or official docs (Context7 when available).

### Security and privacy

- Validate webhook authenticity and inputs; sanitize git refs passed to shell.
- Keep secrets, tokens, raw payloads, and stack traces out of logs, notes, and
  the evals dashboard.
- Public endpoints must not trigger unintended reviews, posts, or paid model calls.

### Compatibility, rollout, and operations

- Check existing rows, migrations, queued work, and mixed old/new runs after deploy.
- Inspect provider-call amplification (note listing, pagination, per-finding
  calls) and unbounded diff, prompt, or session size.
- Material failures must be observable and diagnosable from run records and logs.

### Proof

Choose proof at the layer that owns the risk: unit tests for policy, DB tests for
persistence and transitions, `tests/e2e` against the fake GitLab for end-to-end
posting, replay benchmarks for review-quality changes. Tests must not call live
providers, AI agents, or paid services. `mock.module` registrations are
process-global and mutate namespaces in place: a file that mocks a module must
snapshot `{ ...actual }` before mocking and restore the copy in `afterAll`.

A passing test proves only what it exercises. DB suites skip locally without
`TEST_DATABASE_URL`; record that, and missing negative, race, provider-parity, or
real-flow coverage, as a verification gap.

## Finding standard

Report concrete defects with a realistic trigger and material consequence. Omit
formatting, tool-enforced preferences, speculative hardening, and old issues in
code the diff neither touches nor extends. Respect accepted tradeoffs and scope.

For each finding give the tightest file:line or seam, trigger, impact, missing
handling, and smallest coherent correction. Use P0 for catastrophic impact (for
example publishing someone else's drafts, data loss), P1 for realistic release
blockers, P2 for material defects, and P3 only when nits were requested. No
findings is a valid result; identify meaningful verification gaps.

## Design-debt pass

Every review, including delegated passes, also inspects code the diff touches and
existing code it extends or copies; unrelated untouched code stays out. Skip this
pass only when the user explicitly asks for a narrower review. Look for:

- data encoded in strings and parsed back (markers, note bodies, IDs);
- two sources of truth for one fact;
- one format, path, or constant built in several places;
- GitLab/GitHub or harness logic duplicated instead of behind the port;
- code in the wrong ownership folder, shown by another area importing it;
- escape hatches callers maintain by hand, such as no-op callbacks for missing
  capabilities;
- silent `null` or fallback paths that hide misuse.

Report these after the defects as **Refactor (non-blocking)**: file:line, how the
debt compounds, fix direction, and whether this diff introduced or extended it.
They carry no severity, never block merge, and are not auto-fixed during review
repairs; file a follow-up Beads issue only when the user asks.

## Result

```markdown
### Findings

- [P1] [file:line] Trigger, impact, and smallest correction.

### Refactor (non-blocking)

- [file:line] Debt, how it compounds, fix direction, introduced or extended.

### Open Questions

- Ambiguity that affects correctness.

### Verdict

Assessment, verification gaps, and which evidence is code, tests/CI, or live.
```

Omit empty sections except Verdict. Do not imply checks ran because they exist.
On re-review use the exact current revision, classify prior findings, and inspect
changed paths for regressions. `branch-review` owns readiness gates.
