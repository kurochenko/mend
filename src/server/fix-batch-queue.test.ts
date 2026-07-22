import { beforeEach, describe, expect, mock, test } from 'bun:test'
import type { FixBatchRecord } from '@/db/fix-batches'
import type { ReviewQueueRecord } from '@/db/review-queue'
import type { ReviewFindingRecord } from '@/db/review-findings'

let existingBatch: FixBatchRecord | null = null
let findings: ReviewFindingRecord[] = []
let reviewQueueRecord: ReviewQueueRecord | null = null

const mockGetFixBatchRecord = mock(() => Promise.resolve(existingBatch))
const mockStartFixBatchRun = mock(() => Promise.resolve(existingBatch))
const mockCompleteFixBatchRun = mock(() => Promise.resolve(existingBatch))
const mockFailFixBatchRun = mock(() => Promise.resolve(existingBatch))
const mockUpsertPendingFixBatch = mock<(...args: unknown[]) => Promise<FixBatchRecord>>(
  async (params) => {
    const input = params as {
      projectKey: string
      mrIid: number
      force: boolean
      acceptedFindingIds: string[]
      pendingFindingIds: string[]
    }
    existingBatch = makeBatch({
      projectKey: input.projectKey,
      mrIid: input.mrIid,
      force: input.force,
      acceptedFindingIds: input.acceptedFindingIds,
      pendingFindingIds: input.pendingFindingIds,
    })
    return existingBatch
  },
)
const mockGetReviewFindingByThreadId = mock(() => Promise.resolve(null))
const mockUpdateReviewFindingState = mock(() => Promise.resolve(null))
const mockUpsertReviewFinding = mock(() => Promise.resolve(null))
const mockGetReviewFindingByProviderThreadId = mock(() => Promise.resolve(null))
const mockCountReviewFindingsByStateForMr = mock(() => Promise.resolve({}))
const mockListReviewFindingsForMr = mock(() => Promise.resolve(findings))
const mockGetReviewQueueRecord = mock(() => Promise.resolve(reviewQueueRecord))
const mockUpsertPendingReviewRequest = mock(() => Promise.resolve(reviewQueueRecord))
const mockClaimPendingReviewJob = mock(() => Promise.resolve(null))
const mockDeleteReviewQueueRecord = mock(() => Promise.resolve())
const mockFinishRunningReview = mock(() => Promise.resolve(reviewQueueRecord))
const mockListReviewQueueRecords = mock(() => Promise.resolve([]))
const mockRecoverReviewQueueAfterRestart = mock(() => Promise.resolve(0))
const mockSetPendingCommitSha = mock(() => Promise.resolve(reviewQueueRecord))
const mockSetRunningCommitSha = mock(() => Promise.resolve())

mock.module('@/db/fix-batches', () => ({
  getFixBatchRecord: mockGetFixBatchRecord,
  startFixBatchRun: mockStartFixBatchRun,
  completeFixBatchRun: mockCompleteFixBatchRun,
  failFixBatchRun: mockFailFixBatchRun,
  upsertPendingFixBatch: mockUpsertPendingFixBatch,
}))

mock.module('@/db/review-findings', () => ({
  getReviewFindingByThreadId: mockGetReviewFindingByThreadId,
  updateReviewFindingState: mockUpdateReviewFindingState,
  upsertReviewFinding: mockUpsertReviewFinding,
  getReviewFindingByProviderThreadId: mockGetReviewFindingByProviderThreadId,
  countReviewFindingsByStateForMr: mockCountReviewFindingsByStateForMr,
  listReviewFindingsForMr: mockListReviewFindingsForMr,
}))

mock.module('@/db/review-queue', () => ({
  upsertPendingReviewRequest: mockUpsertPendingReviewRequest,
  claimPendingReviewJob: mockClaimPendingReviewJob,
  deleteReviewQueueRecord: mockDeleteReviewQueueRecord,
  finishRunningReview: mockFinishRunningReview,
  getReviewQueueRecord: mockGetReviewQueueRecord,
  listReviewQueueRecords: mockListReviewQueueRecords,
  recoverReviewQueueAfterRestart: mockRecoverReviewQueueAfterRestart,
  setPendingCommitSha: mockSetPendingCommitSha,
  setRunningCommitSha: mockSetRunningCommitSha,
}))

const { requestAcceptedFixBatch } = await import('@/server/fix-batch-queue')

const makeFinding = (overrides: Partial<ReviewFindingRecord> = {}): ReviewFindingRecord => ({
  id: 'finding-1',
  projectKey: 'test-project',
  mrIid: 42,
  reviewRunId: null,
  threadId: 'thread-1',
  provider: 'gitlab',
  providerThreadId: 'discussion-1',
  providerNoteId: 'note-1',
  state: 'accepted',
  decisionReason: null,
  decidedByExternalId: null,
  decidedByName: null,
  decidedAt: null,
  metadata: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
})

const makeBatch = (overrides: Partial<FixBatchRecord> = {}): FixBatchRecord => ({
  id: 'test-project:42',
  projectKey: 'test-project',
  mrIid: 42,
  status: 'pending',
  force: false,
  loopCount: 0,
  requestNoteId: '999',
  requestThreadId: 'thread-1',
  requestedByExternalId: '200',
  requestedByName: 'developer',
  acceptedFindingIds: ['accepted-1'],
  pendingFindingIds: [],
  sourceBranch: null,
  pushedCommitSha: null,
  result: null,
  failureMessage: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
})

const makeReviewQueueRecord = (overrides: Partial<ReviewQueueRecord> = {}): ReviewQueueRecord => ({
  id: 'test-project:42',
  projectKey: 'test-project',
  mrIid: 42,
  runningEvent: { projectKey: 'test-project', mrIid: 42 },
  runningPayload: {},
  runningCommitSha: 'abc123',
  pendingEvent: null,
  pendingPayload: null,
  pendingCommitSha: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
})

const request = (force = false) =>
  requestAcceptedFixBatch({
    projectKey: 'test-project',
    mrIid: 42,
    enabled: true,
    force,
    requestNoteId: '999',
    requestThreadId: 'thread-1',
    requestedByExternalId: '200',
    requestedByName: 'developer',
  })

beforeEach(() => {
  existingBatch = null
  findings = []
  reviewQueueRecord = null
  mockGetFixBatchRecord.mockClear()
  mockStartFixBatchRun.mockClear()
  mockCompleteFixBatchRun.mockClear()
  mockFailFixBatchRun.mockClear()
  mockUpsertPendingFixBatch.mockClear()
  mockGetReviewFindingByThreadId.mockClear()
  mockUpdateReviewFindingState.mockClear()
  mockUpsertReviewFinding.mockClear()
  mockGetReviewFindingByProviderThreadId.mockClear()
  mockCountReviewFindingsByStateForMr.mockClear()
  mockListReviewFindingsForMr.mockClear()
  mockGetReviewQueueRecord.mockClear()
  mockUpsertPendingReviewRequest.mockClear()
  mockClaimPendingReviewJob.mockClear()
  mockDeleteReviewQueueRecord.mockClear()
  mockFinishRunningReview.mockClear()
  mockListReviewQueueRecords.mockClear()
  mockRecoverReviewQueueAfterRestart.mockClear()
  mockSetPendingCommitSha.mockClear()
  mockSetRunningCommitSha.mockClear()
})

describe('requestAcceptedFixBatch', () => {
  test('refuses when the fix loop is disabled for the project', async () => {
    await expect(
      requestAcceptedFixBatch({
        projectKey: 'test-project',
        mrIid: 42,
        enabled: false,
        force: false,
      }),
    ).resolves.toEqual({
      status: 'refused',
      reason: 'fix_loop_disabled',
      acceptedCount: 0,
      pendingCount: 0,
    })
    expect(mockListReviewFindingsForMr).not.toHaveBeenCalled()
  })

  test('refuses when no accepted findings exist', async () => {
    findings = [makeFinding({ id: 'pending-1', state: 'pending' })]

    await expect(request()).resolves.toEqual({
      status: 'refused',
      reason: 'no_accepted_findings',
      acceptedCount: 0,
      pendingCount: 1,
    })
    expect(mockUpsertPendingFixBatch).not.toHaveBeenCalled()
  })

  test('blocks plain fix accepted when pending findings remain', async () => {
    findings = [
      makeFinding({ id: 'accepted-1', state: 'accepted' }),
      makeFinding({ id: 'pending-1', state: 'pending' }),
    ]

    await expect(request()).resolves.toEqual({
      status: 'refused',
      reason: 'pending_findings',
      acceptedCount: 1,
      pendingCount: 1,
    })
    expect(mockUpsertPendingFixBatch).not.toHaveBeenCalled()
  })

  test('force queues accepted findings despite pending findings', async () => {
    findings = [
      makeFinding({ id: 'accepted-1', state: 'accepted' }),
      makeFinding({ id: 'pending-1', state: 'pending' }),
    ]

    const outcome = await request(true)

    expect(outcome.status).toBe('queued')
    expect(mockUpsertPendingFixBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        force: true,
        acceptedFindingIds: ['accepted-1'],
        pendingFindingIds: ['pending-1'],
      }),
    )
  })

  test('marks queued request as waiting when review is running', async () => {
    findings = [makeFinding({ id: 'accepted-1', state: 'accepted' })]
    reviewQueueRecord = makeReviewQueueRecord()

    const outcome = await request()

    expect(outcome).toEqual(
      expect.objectContaining({
        status: 'queued',
        acceptedCount: 1,
        pendingCount: 0,
        waitingForReview: true,
      }),
    )
  })

  test('returns duplicate when a fix batch is already pending', async () => {
    existingBatch = makeBatch({ status: 'pending' })

    await expect(request()).resolves.toEqual({ status: 'duplicate', batch: existingBatch })
    expect(mockListReviewFindingsForMr).not.toHaveBeenCalled()
    expect(mockUpsertPendingFixBatch).not.toHaveBeenCalled()
  })

  test('serializes concurrent duplicate requests with one MR-level lock', async () => {
    findings = [makeFinding({ id: 'accepted-1', state: 'accepted' })]

    const [first, second] = await Promise.all([request(), request()])

    expect(first.status).toBe('queued')
    expect(second.status).toBe('duplicate')
    expect(mockUpsertPendingFixBatch).toHaveBeenCalledTimes(1)
  })
})
