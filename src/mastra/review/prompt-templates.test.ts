import { describe, expect, it } from 'bun:test'
import {
  buildReviewSystemPrompt,
  DEFAULT_REVIEW_USER_PROMPT,
  FINDER_PREVIOUS_FINDINGS_GUIDANCE,
} from '@/mastra/review/prompt-templates'

const baseInput = {
  mrIid: 1536,
  title: 'style: dashboard refresh',
  description: 'Redesign dashboard table visuals',
  sourceBranch: 'feat/dashboard-refresh',
  targetBranch: 'main',
  url: 'https://example.com/mr/1536',
  reviewMode: 'initial' as const,
  diffBaseRef: 'abc123base',
  previousReviewedSha: null,
  contextPackage: {
    baseRef: 'abc123base',
    changedFiles: ['src/app.ts', 'src/util.ts'],
    fileStats: [
      { file: 'src/app.ts', added: 3, deleted: 1 },
      { file: 'src/util.ts', added: 1, deleted: 0 },
    ],
    diffExcerpt: 'diff --git a/src/app.ts b/src/app.ts\n+new line\n',
    diffTruncated: false,
    diffIncompleteFiles: [],
    maxDiffChars: 48_000,
    changedSymbolCallers: [],
    testsTouchingChangedCode: null,
    diagnostics: [],
  },
}

describe('buildReviewSystemPrompt', () => {
  it('includes MR metadata and scope', () => {
    const prompt = buildReviewSystemPrompt(baseInput)

    expect(prompt).toContain('Review MR !1536')
    expect(prompt).toContain('Base ref: abc123base')
    expect(prompt).toContain('Source branch: feat/dashboard-refresh -> main')
    expect(prompt).toContain('MR URL: https://example.com/mr/1536')
    expect(prompt).toContain('MR title: style: dashboard refresh')
    expect(prompt).toContain('Review mode: initial. Verify all files changed in this MR scope')
  })

  it('includes file inspection and output schema requirements', () => {
    const prompt = buildReviewSystemPrompt(baseInput)

    expect(prompt).toContain(
      'Inspect the changed files that are most relevant to behavior, correctness, tests, and runtime/build/deploy impact before producing final output.',
    )
    expect(prompt).toContain('Trace call graph and dependency direction')
    expect(prompt).toContain('newly introduced cycles')
    expect(prompt).toContain('Use judgment on very large MRs')
    expect(prompt).toContain('"version": "v2"')
    expect(prompt).toContain('Output ONLY the JSON object')
  })

  it('includes changed files and the budgeted diff', () => {
    const prompt = buildReviewSystemPrompt(baseInput)

    expect(prompt).toContain('## Changed files')
    expect(prompt).toContain('- src/app.ts (+3/-1)')
    expect(prompt).toContain('- src/util.ts (+1/-0)')
    expect(prompt).toContain('## Diff')
    expect(prompt).toContain('The diff below is authoritative for what changed')
    expect(prompt).toContain('```diff\ndiff --git a/src/app.ts b/src/app.ts\n+new line\n\n```')
  })

  it('includes retrieval slices when precomputed context is present', () => {
    const prompt = buildReviewSystemPrompt({
      ...baseInput,
      contextPackage: {
        ...baseInput.contextPackage,
        changedSymbolCallers: [
          {
            file: 'src/app.ts',
            symbol: 'runApp',
            sites: [{ file: 'src/server.ts', line: 12 }],
            hiddenSiteCount: 2,
          },
        ],
        testsTouchingChangedCode: {
          testReferences: [{ testFile: 'src/app.test.ts', references: ['src/app.ts', 'runApp'] }],
          changedFilesWithoutTestReferences: ['src/util.ts'],
        },
      },
    })

    expect(prompt).toContain('## Changed-symbol callers')
    expect(prompt).toContain('- runApp — used by: src/server.ts:12 (+2 more)')
    expect(prompt).toContain('## Tests touching changed code')
    expect(prompt).toContain('- src/app.test.ts — references: src/app.ts, runApp')
    expect(prompt).toContain('Changed files with no test references:')
    expect(prompt).toContain('- src/util.ts')
  })

  it('includes truncation guidance and incomplete files when the diff is budgeted', () => {
    const prompt = buildReviewSystemPrompt({
      ...baseInput,
      contextPackage: {
        ...baseInput.contextPackage,
        diffTruncated: true,
        diffIncompleteFiles: ['src/util.ts'],
      },
    })

    expect(prompt).toContain(
      'diff truncated; inspect the remaining files with tools. Files not fully included: src/util.ts',
    )
  })

  it('includes review guardrails', () => {
    const prompt = buildReviewSystemPrompt(baseInput)

    expect(prompt).toContain('Do NOT review or comment on:')
    expect(prompt).toContain('Formatting, whitespace, and import ordering')
    expect(prompt).toContain('Scope anchoring:')
    expect(prompt).toContain('Do not invent findings to satisfy categories')
    expect(prompt).toContain('Do not report the same issue in both findings and inlineComments')
    expect(prompt).toContain(
      'If the issue can be anchored to a specific diff line, prefer inlineComments',
    )
    expect(prompt).toContain(
      'inlineComments[].line is the NEW-file line number and must be a line added or changed in the diff shown above',
    )
    expect(prompt).toContain(
      'Before emitting a finding, re-read the exact lines you cite; every finding must include at least one file_line evidence entry',
    )
    expect(prompt).not.toContain('"meta":')
  })

  it('includes context7 tool hint', () => {
    const prompt = buildReviewSystemPrompt(baseInput)

    expect(prompt).toContain('context7_lookup')
  })

  it('uses consecutive wording for update mode', () => {
    const prompt = buildReviewSystemPrompt({
      ...baseInput,
      reviewMode: 'update',
      previousReviewedSha: 'prev123',
    })

    expect(prompt).toContain('Review mode: consecutive update')
    expect(prompt).toContain('previous reviewed SHA prev123')
    expect(prompt).toContain(
      'verify each previous finding and answer via the resolutionVerdicts array; do not re-post previous findings as new findings',
    )
  })

  it('omits update-mode previous finding guidance for initial reviews', () => {
    const prompt = buildReviewSystemPrompt(baseInput)

    expect(prompt).not.toContain('resolutionVerdicts array; do not re-post previous findings')
  })
})

describe('DEFAULT_REVIEW_USER_PROMPT', () => {
  it('contains focus areas', () => {
    expect(DEFAULT_REVIEW_USER_PROMPT).toContain('Focus areas:')
    expect(DEFAULT_REVIEW_USER_PROMPT).toContain('correctness and regressions')
    expect(DEFAULT_REVIEW_USER_PROMPT).toContain('design quality and decomposition')
    expect(DEFAULT_REVIEW_USER_PROMPT).toContain('mostly acyclic call/dependency flow')
    expect(DEFAULT_REVIEW_USER_PROMPT).toContain('convention adherence')
  })

  it('contains testing policy', () => {
    expect(DEFAULT_REVIEW_USER_PROMPT).toContain('Do not require or request UI/component tests')
  })

  it('contains AGENTS.md instruction', () => {
    expect(DEFAULT_REVIEW_USER_PROMPT).toContain('Read repository root AGENTS.md')
  })
})

describe('FINDER_PREVIOUS_FINDINGS_GUIDANCE', () => {
  it('treats resolved decisions as settled and unresolved findings as already tracked', () => {
    expect(FINDER_PREVIOUS_FINDINGS_GUIDANCE).toContain('marked resolved are settled decisions')
    expect(FINDER_PREVIOUS_FINDINGS_GUIDANCE).toContain(
      'even if the code moved to another file or line',
    )
    expect(FINDER_PREVIOUS_FINDINGS_GUIDANCE).toContain(
      'Unresolved previous findings are tracked elsewhere',
    )
    expect(FINDER_PREVIOUS_FINDINGS_GUIDANCE).toContain('Focus on genuinely new issues')
  })
})
