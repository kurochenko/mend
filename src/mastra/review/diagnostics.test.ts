import { describe, expect, it } from 'bun:test'
import { reviewDiagnosticsSchema } from '@/mastra/review/diagnostics'

describe('reviewDiagnosticsSchema', () => {
  it('defaults missing agent diagnostics for persisted pre-harness review results', () => {
    const parsed = reviewDiagnosticsSchema.parse({
      reviewMode: 'initial',
      previousReviewedSha: null,
      diffBaseRef: 'main',
      changedFileCount: 1,
      diffExcerptChars: 100,
      diffTruncated: false,
      intentClassifierModel: 'classifier-model',
      intentClassifierDurationMs: 10,
      intentClassifierFailure: null,
      intentSecondaryIntents: [],
      inspection: {
        files: [],
        changedFiles: [],
        changedFileCount: 0,
        changedFileCoverage: 0,
      },
      templateWarnings: [],
    })

    expect(parsed.agent).toEqual({
      harness: 'pi',
      model: 'unknown',
      durationMs: null,
    })
  })
})
