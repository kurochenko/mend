import { describe, expect, it } from 'bun:test'
import {
  matchExpectedFindings,
  scoreBenchmarkCase,
  scoreReviewOutput,
  type BenchmarkCase,
} from '@/mastra/review/eval/scoring'
import type { PostStepOutput } from '@/mastra/review/run-result'
import type { ReviewOutputV2 } from '@/mastra/review/schema'

const reviewOutput = (overrides: Partial<ReviewOutputV2> = {}): ReviewOutputV2 => ({
  version: 'v2',
  assessment: 'needs_discussion',
  summary: 'summary',
  findings: [
    {
      id: 'missing-await',
      category: 'correctness',
      severity: 'bug',
      actionability: 'required',
      scope: 'single_file',
      title: 'Missing await hides failed payment',
      body: 'The charge promise is returned before the failed payment is handled.',
      files: ['src/payments/charge.ts'],
      evidence: [
        {
          type: 'file_line',
          file: 'src/payments/charge.ts',
          line: 42,
        },
      ],
    },
    {
      id: 'nit',
      category: 'convention',
      severity: 'suggestion',
      actionability: 'optional',
      scope: 'single_file',
      title: 'Rename local variable',
      body: 'The local variable name could be shorter.',
      files: ['src/payments/charge.ts'],
      evidence: [
        {
          type: 'file_line',
          file: 'src/payments/charge.ts',
          line: 12,
        },
      ],
    },
  ],
  inlineComments: [
    {
      file: 'src/refunds/refund.ts',
      line: 88,
      severity: 'bug',
      body: 'Refund failures are swallowed here.',
    },
  ],
  resolutionVerdicts: [
    {
      previousFindingId: 'prev-1',
      status: 'fixed',
      explanation: 'The missing await was added.',
    },
  ],
  ...overrides,
})

const postOutput = (overrides: Partial<PostStepOutput> = {}): PostStepOutput => ({
  ...reviewOutput(),
  projectKey: 'demo',
  mrIid: 7,
  reviewRunId: 'run-7',
  url: 'https://example.com/mr/7',
  commitSha: 'abc123',
  reviewMode: 'update',
  previousReviewedSha: 'base123',
  previousRunId: 'run-6',
  reviewIntent: 'feature',
  reviewIntentConfidence: 0.9,
  reviewIntentRationale: ['fixture'],
  reviewTemplateId: 'feature',
  reviewTemplateSource: 'classifier',
  meta: {
    templateId: 'feature',
    intent: 'feature',
    confidence: 0.9,
    selectionSource: 'classifier',
  },
  featureFlags: {
    promptTemplatesV2: true,
    schemaV2: true,
    structuredFindingsPost: true,
    structuralSignals: true,
    bugHistory: true,
    dryRun: false,
  },
  reviewDiagnostics: {
    reviewMode: 'update',
    previousReviewedSha: 'base123',
    diffBaseRef: 'base123',
    changedFileCount: 2,
    diffExcerptChars: 1200,
    diffTruncated: false,
    intentClassifierModel: 'test-model',
    intentClassifierDurationMs: 100,
    intentClassifierFailure: null,
    intentSecondaryIntents: [],
    agent: {
      harness: 'pi',
      model: 'test-model',
      durationMs: 1000,
    },
    inspection: {
      files: ['src/payments/charge.ts'],
      changedFiles: ['src/payments/charge.ts'],
      changedFileCount: 1,
      changedFileCoverage: 1,
    },
    contextPackageDiagnostics: [],
    templateWarnings: [],
  },
  comparisonResult: null,
  activeReviewMemoryEntries: [],
  postedInlineComments: [],
  postedFindings: [],
  threadedFindings: [],
  threadedInlineComments: [],
  postDiagnostics: {
    findingsCount: 2,
    outOfScopeFindingCount: 0,
    inlineCommentCount: 1,
    outOfScopeInlineCount: 0,
    postedInlineCount: 1,
    preExistingDraftCount: 0,
    recoveredDraftCount: 0,
    draftRecoveryAction: 'none',
    skippedInlineReasons: {},
    resolvedThreadCount: 0,
    partiallyFixedThreadCount: 0,
    unmatchedVerdictCount: 0,
    persistedFindingCount: 0,
    dedupedExistingThreadCount: 0,
    suppressedResolvedThreadCount: 0,
    automaticFixBatchStatus: null,
  },
  posted: 1,
  skipped: 0,
  reviewNumber: 1,
  summaryNoteId: 1,
  ...overrides,
})

describe('matchExpectedFindings', () => {
  it('matches glob, line range with tolerance, category, and case-insensitive pattern', () => {
    const result = matchExpectedFindings(reviewOutput(), [
      {
        id: 'payment-await',
        fileGlob: 'src/payments/**',
        lineRange: { from: 45, to: 45 },
        category: 'correctness',
        pattern: 'FAILED PAYMENT',
      },
      {
        id: 'refund-swallow',
        fileGlob: 'src/refunds/*.ts',
        lineRange: { from: 85, to: 85 },
        pattern: 'swallowed',
      },
    ])

    expect(result.matched.map((item) => item.expectationId)).toEqual([
      'payment-await',
      'refund-swallow',
    ])
    expect(result.missedExpected).toEqual([])
  })

  it('matches expectations without a fileGlob against items on any file', () => {
    const result = matchExpectedFindings(reviewOutput(), [
      {
        id: 'anywhere-swallow',
        pattern: 'swallowed',
      },
    ])

    expect(result.matched.map((item) => item.expectationId)).toEqual(['anywhere-swallow'])
    expect(result.missedExpected).toEqual([])
  })

  it('requires category and line tolerance to match', () => {
    const result = matchExpectedFindings(reviewOutput(), [
      {
        id: 'wrong-category',
        fileGlob: 'src/payments/**',
        category: 'security',
        pattern: 'failed payment',
      },
      {
        id: 'line-too-far',
        fileGlob: 'src/refunds/**',
        lineRange: { from: 70, to: 70 },
        pattern: 'swallowed',
      },
    ])

    expect(result.matched).toEqual([])
    expect(result.missedExpected).toEqual(['wrong-category', 'line-too-far'])
  })

  it('uses greedy one-to-one matching', () => {
    const result = matchExpectedFindings(reviewOutput(), [
      {
        id: 'specific',
        fileGlob: 'src/payments/**',
        lineRange: { from: 42, to: 42 },
        category: 'correctness',
        pattern: 'missing await',
      },
      {
        id: 'duplicate',
        fileGlob: 'src/payments/**',
        pattern: 'missing await',
      },
    ])

    expect(result.matched).toHaveLength(1)
    expect(result.matched[0]?.expectationId).toBe('specific')
    expect(result.missedExpected).toEqual(['duplicate'])
  })
})

describe('scoreReviewOutput', () => {
  it('scores recall, forbidden false positives, unmatched items, and verdict accuracy', () => {
    const score = scoreReviewOutput(
      {
        expectedFindings: [
          {
            id: 'payment-await',
            fileGlob: 'src/payments/**',
            category: 'correctness',
            pattern: 'failed payment',
          },
          {
            id: 'missing-security',
            fileGlob: 'src/security/**',
            category: 'security',
            pattern: 'token',
          },
        ],
        forbiddenFindings: [
          {
            id: 'style-nit',
            fileGlob: 'src/payments/**',
            pattern: 'variable name',
          },
        ],
        expectedResolutionVerdicts: [
          {
            previousFindingRef: 'prev-1',
            status: 'fixed',
          },
          {
            previousFindingRef: 'prev-2',
            status: 'not_fixed',
          },
        ],
      },
      reviewOutput(),
    )

    expect(score.recall).toBe(0.5)
    expect(score.falsePositiveHits.map((item) => item.forbiddenId)).toEqual(['style-nit'])
    expect(score.unmatchedItems.map((item) => item.title)).toEqual([
      'Refund failures are swallowed here.',
    ])
    expect(score.verdictAccuracy).toBe(0.5)
    expect(score.passed).toBe(false)
  })
})

describe('scoreBenchmarkCase', () => {
  it('scores primary and comparison reviews with the same expectations', () => {
    const testCase: BenchmarkCase = {
      name: 'demo-7',
      projectKey: 'demo',
      mrIid: 7,
      expectation: {
        expectedFindings: [
          {
            id: 'payment-await',
            fileGlob: 'src/payments/**',
            category: 'correctness',
            pattern: 'failed payment',
          },
        ],
        forbiddenFindings: [
          {
            id: 'style-nit',
            pattern: 'variable name',
          },
        ],
      },
    }
    const output = postOutput({
      comparisonResult: {
        harness: 'codex',
        status: 'success',
        durationMs: 500,
        review: reviewOutput({
          findings: [],
          inlineComments: [],
        }),
      },
    })

    const score = scoreBenchmarkCase(testCase, output)

    expect(score.primary.recall).toBe(1)
    expect(score.primary.falsePositiveHits).toHaveLength(1)
    expect(score.comparison?.comparisonHarness).toBe('codex')
    expect(score.comparison?.recall).toBe(0)
    expect(score.comparison?.falsePositiveHits).toHaveLength(0)
  })
})
