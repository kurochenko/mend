import { describe, expect, it } from 'bun:test'
import { isExcludedFromReviewScope, partitionReviewScopeFiles } from '@/mastra/review/file-filter'

describe('isExcludedFromReviewScope', () => {
  it('excludes generated, snapshot, and lock files', () => {
    expect(isExcludedFromReviewScope('bun.lock')).toBe(true)
    expect(isExcludedFromReviewScope('src/http/generated/v3/client/index.ts')).toBe(true)
    expect(isExcludedFromReviewScope('src/http/generated/v3/core/types.gen.ts')).toBe(true)
    expect(isExcludedFromReviewScope('openapi/loan-case-v3.json')).toBe(true)
    expect(isExcludedFromReviewScope('src/http/__snapshots__/index.test.ts.snap')).toBe(true)
    expect(isExcludedFromReviewScope('src/http/index.test.ts.snap')).toBe(true)
  })

  it('keeps normal source files in review scope', () => {
    expect(isExcludedFromReviewScope('src/server/mr-review-queue.ts')).toBe(false)
    expect(isExcludedFromReviewScope('src/index.ts')).toBe(false)
  })
})

describe('partitionReviewScopeFiles', () => {
  it('partitions and de-duplicates files while preserving order', () => {
    const result = partitionReviewScopeFiles([
      './src/index.ts',
      'bun.lock',
      'src/index.ts',
      'src/http/__snapshots__/index.test.ts.snap',
      'src/http/generated/v3/core/types.gen.ts',
      'src/server/mr-review-queue.ts',
    ])

    expect(result.includedFiles).toEqual(['src/index.ts', 'src/server/mr-review-queue.ts'])
    expect(result.excludedFiles).toEqual([
      'bun.lock',
      'src/http/__snapshots__/index.test.ts.snap',
      'src/http/generated/v3/core/types.gen.ts',
    ])
  })
})
