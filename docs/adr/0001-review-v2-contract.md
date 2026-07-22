# ADR 0001: Review prompt templates and schema v2 contract

## Status

Accepted

## Date

2026-02-26

## Context

MR reviews currently optimize for inline line-level findings only. This blocks high-value output for style and refactor MRs where the most important findings are often cross-file duplication, convention drift, dead code, and architectural cohesion.

The review system needs deterministic prompt strategy selection and a richer structured output contract while keeping GitLab inline comments for line-anchored issues.

## Decision

### 1) Prompt template catalog

The review step uses intent-routed templates:

- `style_refactor`
- `feature`
- `bugfix`
- `security_sensitive`
- `mixed`

Template selection is controlled by orchestration, not by Pi internals.

Selection precedence:

1. explicit config override
2. MR label override
3. automatic classifier result
4. fallback to `mixed`

### 2) Review schema contract

The system adopts a strict `v2`-only schema.

Required top-level fields:

- `version`: `"v2"`
- `assessment`: `"approve" | "request_changes" | "needs_discussion"`
- `summary`: string
- `findings`: array of structured non-inline findings
- `inlineComments`: array of line-anchored findings for GitLab inline notes
- `meta`: template and selection metadata

Required `finding` fields:

- `id`: string
- `category`: `"correctness" | "architecture" | "duplication" | "convention" | "dead_code" | "performance" | "security" | "testing"`
- `severity`: `"bug" | "security" | "performance" | "suggestion"`
- `actionability`: `"required" | "recommended" | "optional"`
- `scope`: `"single_file" | "cross_file" | "project"`
- `title`: string
- `body`: string
- `evidence`: array

Optional `finding` fields:

- `files`: string[]

Required `inlineComment` fields:

- `file`: string
- `line`: number
- `severity`: `"bug" | "security" | "performance" | "suggestion"`
- `body`: string

Optional `inlineComment` fields:

- `suggestion`: string

Required `meta` fields:

- `templateId`: one of template IDs above
- `intent`: one of template IDs above
- `confidence`: number in `[0, 1]`
- `selectionSource`: `"config" | "label" | "classifier" | "fallback"`

### 3) Posting behavior

The post step publishes:

1. one summary note containing `assessment`, `summary`, and grouped `findings`
2. inline draft notes from `inlineComments`

If no inline position can be resolved, the issue is retained in the summary note with a skipped-inline entry.

## Consequences

- Style/refactor reviews can return high-value findings without forcing file/line anchors.
- Posting remains compatible with GitLab inline review UX for line-based issues.
- Review runs are easier to evaluate because template selection and confidence are explicit.
- There is no v1 parser path in this rollout.

## Example A: style/refactor MR

```json
{
  "version": "v2",
  "assessment": "needs_discussion",
  "summary": "Dashboard redesign improves UX but retains avoidable cross-file duplication and repeated utility-class clusters.",
  "meta": {
    "templateId": "style_refactor",
    "intent": "style_refactor",
    "confidence": 0.93,
    "selectionSource": "classifier"
  },
  "findings": [
    {
      "id": "dup-dashboard-layout",
      "category": "duplication",
      "severity": "suggestion",
      "actionability": "recommended",
      "scope": "cross_file",
      "title": "OO and BTL1 dashboard views duplicate the same layout",
      "body": "Both views render the same wrapper/header/search/error/empty/table/pagination sequence and differ mostly by product config and routing details.",
      "files": [
        "src/components/features/ownerOccupied/views/Dashboard.vue",
        "src/components/features/btlFirst/views/Dashboard.vue"
      ],
      "evidence": [
        {
          "type": "file_line",
          "file": "src/components/features/ownerOccupied/views/Dashboard.vue",
          "line": 1,
          "note": "Template structure matches BTL1 view"
        },
        {
          "type": "file_line",
          "file": "src/components/features/btlFirst/views/Dashboard.vue",
          "line": 1,
          "note": "Template structure matches OO view"
        }
      ]
    }
  ],
  "inlineComments": [
    {
      "file": "src/components/features/shared/dashboard/DashboardCaseTable.vue",
      "line": 80,
      "severity": "suggestion",
      "body": "`backdrop-blur-[1px]` is an arbitrary value; prefer a standard Tailwind blur token unless this exact value is required."
    }
  ]
}
```

## Example B: bugfix MR

```json
{
  "version": "v2",
  "assessment": "request_changes",
  "summary": "The fix addresses the primary null-path but misses one branch where stale state can still leak into the response.",
  "meta": {
    "templateId": "bugfix",
    "intent": "bugfix",
    "confidence": 0.89,
    "selectionSource": "classifier"
  },
  "findings": [
    {
      "id": "missing-regression-test",
      "category": "testing",
      "severity": "suggestion",
      "actionability": "recommended",
      "scope": "single_file",
      "title": "Regression scenario is not covered by tests",
      "body": "The added branch changes behavior for absent account IDs, but no test asserts this path.",
      "files": [
        "src/services/accounts.ts",
        "src/services/accounts.test.ts"
      ],
      "evidence": [
        {
          "type": "symbol",
          "value": "resolveAccountForUser"
        }
      ]
    }
  ],
  "inlineComments": [
    {
      "file": "src/services/accounts.ts",
      "line": 142,
      "severity": "bug",
      "body": "This branch returns cached data without verifying ownership, which can leak stale account details across users."
    }
  ]
}
```
