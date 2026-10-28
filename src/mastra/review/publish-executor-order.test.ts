import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { ProjectConfig } from '@/config'
import type { ReviewProvider } from '@/integrations/provider/client'
import type { PostPlan } from '@/mastra/review/publish-plan'
import * as actualThreadSyncModule from '@/server/thread-sync'

const actualThreadSync = { ...actualThreadSyncModule }
const calls: string[] = []
const mockPersistPostedReviewFindings = mock(async () => {
  calls.push('persistFindings')
  return []
})

mock.module('@/server/thread-sync', () => ({
  ...actualThreadSync,
  persistPublishedThreads: mock(async () => {
    calls.push('persistThreads')
    return { summaryNoteId: null, inlineComments: [], summaryFindings: [] }
  }),
  persistPostedReviewFindings: mockPersistPostedReviewFindings,
}))

afterAll(() => {
  mock.module('@/server/thread-sync', () => actualThreadSync)
})

const { executePostPlan } = await import('@/mastra/review/publish-executor')

const provider = {
  publishReviewBatch: mock(async () => {
    calls.push('publishReviewBatch')
    return { preExistingDraftCount: 0, recoveredDraftCount: 0, draftRecoveryAction: 'none' }
  }),
  publishSummaryNote: mock(async () => {
    calls.push('publishSummaryNote')
    return { id: 42, reconciled: false }
  }),
  listThreads: mock(async () => []),
} as unknown as ReviewProvider

const plan = {
  input: { mrIid: 7, projectKey: 'demo', reviewRunId: 'run-1', resolutionVerdicts: [] },
  findings: [],
  inlineComments: [],
  inlineDrafts: [],
  findingDiscussions: [],
  diffRefs: { baseSha: 'base', headSha: 'head' },
  markedSummaryBody: 'summary',
  threadResolutions: [],
  unmatchedVerdictCount: 0,
} as unknown as PostPlan

describe('executePostPlan publish order', () => {
  beforeEach(() => {
    calls.length = 0
    mockPersistPostedReviewFindings.mockImplementation(async () => {
      calls.push('persistFindings')
      return []
    })
  })

  test('creates the summary note after every other post step', async () => {
    const result = await executePostPlan({ plan, project: {} as ProjectConfig, provider })

    expect(calls.indexOf('publishSummaryNote')).toBeGreaterThan(calls.indexOf('persistFindings'))
    expect(calls[0]).toBe('publishReviewBatch')
    expect(calls.at(-1)).toBe('persistThreads')
    expect(result.summaryNoteId).toBe(42)
  })

  test('posts no summary when an earlier post step fails', async () => {
    mockPersistPostedReviewFindings.mockImplementation(async () => {
      throw new Error('db down')
    })

    await expect(executePostPlan({ plan, project: {} as ProjectConfig, provider })).rejects.toThrow(
      'db down',
    )
    expect(calls).not.toContain('publishSummaryNote')
  })
})
