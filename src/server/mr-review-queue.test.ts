import { beforeEach, describe, expect, mock, test } from 'bun:test'
import type { Mastra } from '@mastra/core'
import type { AppConfig, ProjectConfig } from '@/config'
import type { ReviewQueueJob, ReviewQueueRecord } from '@/db/review-queue'
import type { ReviewProvider } from '@/integrations/provider/client'
import type { MrReviewRequestEvent } from '@/lib/review-events'
import type { executeMrReview as executeMrReviewFunction } from '@/mastra/run-mr-review'
import type { syncStatusNote } from '@/server/status-note-sync'

const mockUpsertPendingReviewRequest =
  mock<(params: { event: MrReviewRequestEvent; payload: unknown }) => Promise<ReviewQueueRecord>>()
const mockClaimPendingReviewJob = mock<
  (projectKey: string, mrIid: number) => Promise<ReviewQueueJob | null>
>(() => Promise.resolve(null))
const mockDeleteReviewQueueRecord = mock(() => Promise.resolve())
const mockFinishRunningReview = mock<() => Promise<ReviewQueueRecord | null>>(() =>
  Promise.resolve(null),
)
const mockGetReviewQueueRecord = mock<() => Promise<ReviewQueueRecord | null>>(() =>
  Promise.resolve(null),
)
const mockListReviewQueueRecords = mock(() => Promise.resolve<ReviewQueueRecord[]>([]))
const mockRecoverReviewQueueAfterRestart = mock(() => Promise.resolve(0))
const mockSetPendingCommitSha = mock(() => Promise.resolve(null))
const mockSetRunningCommitSha = mock(() => Promise.resolve())
const mockUpdateReviewRunResult = mock(() => Promise.resolve())

const mockGetServiceRuntimeMode = mock(() => Promise.resolve<'running' | 'draining'>('running'))
const mockFetchChangeRequest = mock(() =>
  Promise.resolve({
    sha: 'abc123',
    title: '',
    description: '',
    labels: [],
    sourceBranch: '',
    targetBranch: '',
    url: '',
  }),
)
const mockHasSuccessfulRunForSha = mock(() => Promise.resolve(false))
const mockGetLatestSuccessfulRun = mock(() => Promise.resolve(null))
const mockExecuteMrReview = mock<typeof executeMrReviewFunction>(() =>
  Promise.resolve({
    reviewRunId: 'run-1',
    workflowRunId: 'wf-1',
    workflowResult: { status: 'success', result: {}, input: {}, steps: {} },
  }),
)
const fakeProvider: ReviewProvider = {
  kind: 'gitlab',
  fetchCurrentUser: mock(() => Promise.resolve({ id: 100, username: 'mend-bot' })),
  fetchChangeRequest: mockFetchChangeRequest,
  fetchDiffRefs: mock(() =>
    Promise.resolve({ baseSha: 'base', headSha: 'head', startSha: 'start' }),
  ),
  fetchChangedFiles: mock(() => Promise.resolve(['src/app.ts'])),
  listNotes: mock(() => Promise.resolve([])),
  createNote: mock(() => Promise.resolve({ id: 1, body: '', author: null })),
  updateNote: mock(() => Promise.resolve({ id: 1, body: '', author: null })),
  deleteNote: mock(() => Promise.resolve()),
  listThreads: mock(() => Promise.resolve([])),
  getThread: mock(() =>
    Promise.resolve({ id: 'discussion-1', isThread: true, messages: [], raw: {} }),
  ),
  createThread: mock(() =>
    Promise.resolve({ id: 'discussion-1', isThread: true, messages: [], raw: {} }),
  ),
  replyToThread: mock(() =>
    Promise.resolve({
      id: '1',
      body: '',
      author: { id: 100, username: 'mend-bot', raw: {} },
      resolvable: false,
      position: null,
      raw: {},
    }),
  ),
  resolveThread: mock(() => Promise.resolve()),
  addNoteReaction: mock(() => Promise.resolve()),
  addThreadMessageReaction: mock(() => Promise.resolve()),
  publishReviewBatch: mock(() =>
    Promise.resolve({
      preExistingDraftCount: 0,
      recoveredDraftCount: 0,
      draftRecoveryAction: 'none' as const,
      summaryNoteId: 1,
      summaryReconciled: false,
    }),
  ),
}
const mockCreateReviewProvider = mock(() => fakeProvider)
const mockSyncStatusNote = mock<typeof syncStatusNote>(() => Promise.resolve(true))

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

mock.module('@/db/service-runtime', () => ({
  getServiceRuntimeMode: mockGetServiceRuntimeMode,
}))

mock.module('@/server/review-context', () => ({
  hasSuccessfulRunForSha: mockHasSuccessfulRunForSha,
  getLatestSuccessfulRun: mockGetLatestSuccessfulRun,
}))

mock.module('@/mastra/run-mr-review', () => ({
  executeMrReview: mockExecuteMrReview,
}))

const {
  enqueueMrReview,
  hasActiveReviewWorkers,
  recoverPersistedReviewQueue,
  resumePersistedReviewQueue,
} = await import('@/server/mr-review-queue')

const makeMastra = () => ({}) as Mastra

const makeProject = (): ProjectConfig => ({
  key: 'test-project',
  platform: 'gitlab',
  url: 'https://gitlab.example.com',
  token: 'test-token',
  webhook_secret: 'secret',
  project_id: 1,
  repo_url: 'https://gitlab.example.com/test/repo.git',
  default_branch: 'main',
  clone_path: '/tmp/test',
  trigger: { mode: 'ready' },
  review: {
    llm: { model: 'test-model', thinking_level: 'medium' },
    agent: { harness: 'pi' },
    template: { prompt: 'auto', label_prefix: 'ai-review:' },
    flags: {
      prompt_templates_v2: true,
      schema_v2: true,
      structured_findings_post: true,
      structural_signals: true,
      bug_history: true,
      dry_run: false,
    },
    intent: {
      harness: 'pi',
      model: 'test-model',
      thinking_level: 'minimal',
      timeout_ms: 45000,
      failure_policy: 'mixed',
    },
    comparison: { enabled: false, harness: 'opencode', timeout_ms: 300_000 },
    memory: { project_scope_usernames: [] },
    triage: { trusted_usernames: [] },
    fix: { enabled: false, automatic: false, max_loops: 3 },
  },
  tools: { context7: {} },
})

const makeConfig = (): AppConfig => ({
  env: {
    PORT: 3147,
    DATABASE_URL: 'postgres://localhost/mend',
    PROJECTS_CONFIG: 'mend.yml',
    RECORD_WEBHOOKS: false,
  },
  projects: new Map([['test-project', makeProject()]]),
  improvements: {
    enabled: false,
    interval_days: 7,
    agent: { harness: 'codex', model: 'gpt-5.5', thinking_level: 'low', timeout_ms: 120_000 },
  },
})

const makeEvent = (overrides: Partial<MrReviewRequestEvent> = {}): MrReviewRequestEvent => ({
  projectKey: 'test-project',
  mrIid: 42,
  title: 'Test MR',
  description: 'A test merge request',
  labels: [],
  sourceBranch: 'feature/test',
  targetBranch: 'main',
  url: 'https://gitlab.example.com/test/-/merge_requests/42',
  ...overrides,
})

const makePayload = (sha = 'abc123'): unknown => ({
  object_kind: 'merge_request',
  object_attributes: {
    last_commit: {
      id: sha,
    },
  },
})

const makeQueueRecord = (overrides: Partial<ReviewQueueRecord> = {}): ReviewQueueRecord => ({
  id: 'test-project:42',
  projectKey: 'test-project',
  mrIid: 42,
  runningEvent: null,
  runningPayload: null,
  runningCommitSha: null,
  pendingEvent: makeEvent(),
  pendingPayload: { object_kind: 'merge_request' },
  pendingCommitSha: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
})

const statusInputs = (): Record<string, unknown>[] =>
  mockSyncStatusNote.mock.calls.map(
    (call) => (call as unknown as [{ input: Record<string, unknown> }])[0].input,
  )

const enqueueReview = async (
  params: Omit<Parameters<typeof enqueueMrReview>[0], 'dependencies'> & {
    dependencies?: Parameters<typeof enqueueMrReview>[0]['dependencies']
  },
): Promise<void> => {
  await enqueueMrReview({
    ...params,
    dependencies: {
      ...queueDependencies(),
      ...params.dependencies,
    },
  })
}

const waitForWorker = async (): Promise<void> => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!hasActiveReviewWorkers()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const queueDependencies = (): Parameters<typeof enqueueMrReview>[0]['dependencies'] => ({
  claimPendingReviewJob: mockClaimPendingReviewJob,
  deleteReviewQueueRecord: mockDeleteReviewQueueRecord,
  finishRunningReview: mockFinishRunningReview,
  getReviewQueueRecord: mockGetReviewQueueRecord,
  listReviewQueueRecords: mockListReviewQueueRecords,
  recoverReviewQueueAfterRestart: mockRecoverReviewQueueAfterRestart,
  setPendingCommitSha: mockSetPendingCommitSha,
  setRunningCommitSha: mockSetRunningCommitSha,
  upsertPendingReviewRequest: mockUpsertPendingReviewRequest,
  getServiceRuntimeMode: mockGetServiceRuntimeMode,
  createReviewProvider: mockCreateReviewProvider,
  hasSuccessfulRunForSha: mockHasSuccessfulRunForSha,
  getLatestSuccessfulRun: mockGetLatestSuccessfulRun,
  executeMrReview: mockExecuteMrReview,
  syncStatusNote: mockSyncStatusNote,
  updateReviewRunResult: mockUpdateReviewRunResult,
})

beforeEach(() => {
  mockUpsertPendingReviewRequest.mockReset()
  mockClaimPendingReviewJob.mockReset()
  mockDeleteReviewQueueRecord.mockReset()
  mockFinishRunningReview.mockReset()
  mockGetReviewQueueRecord.mockReset()
  mockListReviewQueueRecords.mockReset()
  mockRecoverReviewQueueAfterRestart.mockReset()
  mockSetPendingCommitSha.mockReset()
  mockSetRunningCommitSha.mockReset()
  mockUpdateReviewRunResult.mockReset()
  mockGetServiceRuntimeMode.mockReset()
  mockFetchChangeRequest.mockReset()
  mockHasSuccessfulRunForSha.mockReset()
  mockGetLatestSuccessfulRun.mockReset()
  mockExecuteMrReview.mockReset()
  mockCreateReviewProvider.mockReset()
  mockSyncStatusNote.mockReset()

  mockUpsertPendingReviewRequest.mockImplementation(async ({ event, payload }) =>
    makeQueueRecord({ pendingEvent: event, pendingPayload: payload }),
  )
  mockClaimPendingReviewJob.mockImplementation(() => Promise.resolve(null))
  mockDeleteReviewQueueRecord.mockImplementation(() => Promise.resolve())
  mockFinishRunningReview.mockImplementation(() => Promise.resolve(null))
  mockGetReviewQueueRecord.mockImplementation(() => Promise.resolve(null))
  mockListReviewQueueRecords.mockImplementation(() => Promise.resolve([]))
  mockRecoverReviewQueueAfterRestart.mockImplementation(() => Promise.resolve(0))
  mockSetPendingCommitSha.mockImplementation(() => Promise.resolve(null))
  mockSetRunningCommitSha.mockImplementation(() => Promise.resolve())
  mockUpdateReviewRunResult.mockImplementation(() => Promise.resolve())
  mockGetServiceRuntimeMode.mockImplementation(() => Promise.resolve('running'))
  mockFetchChangeRequest.mockImplementation(() =>
    Promise.resolve({
      sha: 'abc123',
      title: '',
      description: '',
      labels: [],
      sourceBranch: '',
      targetBranch: '',
      url: '',
    }),
  )
  mockHasSuccessfulRunForSha.mockImplementation(() => Promise.resolve(false))
  mockGetLatestSuccessfulRun.mockImplementation(() => Promise.resolve(null))
  mockExecuteMrReview.mockImplementation(() =>
    Promise.resolve({
      reviewRunId: 'run-1',
      workflowRunId: 'wf-1',
      workflowResult: { status: 'success', result: {}, input: {}, steps: {} },
    }),
  )
  mockCreateReviewProvider.mockImplementation(() => fakeProvider)
  mockSyncStatusNote.mockImplementation(() => Promise.resolve(true))
})

describe('enqueueMrReview', () => {
  test('queues and starts a new review when nothing is running', async () => {
    const event = makeEvent()
    mockClaimPendingReviewJob
      .mockImplementationOnce(() =>
        Promise.resolve({
          id: 'test-project:42',
          projectKey: 'test-project',
          mrIid: 42,
          event,
          payload: makePayload(),
          commitSha: null,
        }),
      )
      .mockImplementation(() => Promise.resolve(null))

    await enqueueReview({
      mastra: makeMastra(),
      project: makeProject(),
      payload: makePayload(),
      event,
    })

    await new Promise((resolve) => setTimeout(resolve, 40))

    expect(mockExecuteMrReview).toHaveBeenCalledTimes(1)
    expect(statusInputs().some((input) => input.state === 'queued')).toBe(true)
    expect(statusInputs().some((input) => input.state === 'running')).toBe(true)
  })

  test('pins pending work to enqueue-time SHA before the worker starts', async () => {
    await enqueueReview({
      mastra: makeMastra(),
      project: makeProject(),
      payload: makePayload(),
      event: makeEvent(),
    })

    expect(mockSetPendingCommitSha).toHaveBeenCalledWith('test-project', 42, 'abc123')
  })

  test('newer webhook keeps status running when a review is already running', async () => {
    const event = makeEvent()
    mockUpsertPendingReviewRequest.mockImplementation(async ({ payload }) =>
      makeQueueRecord({
        runningEvent: event,
        runningPayload: { first: true },
        runningCommitSha: 'running-sha',
        pendingEvent: event,
        pendingPayload: payload,
      }),
    )

    await enqueueReview({
      mastra: makeMastra(),
      project: makeProject(),
      payload: makePayload('def456'),
      event,
    })

    expect(
      statusInputs().some(
        (input) =>
          input.state === 'running' &&
          input.message === 'Review is in progress; newer update queued',
      ),
    ).toBe(true)
  })

  test('same-SHA webhook does not queue a second run while review is already running', async () => {
    const event = makeEvent({ title: 'Updated title' })
    mockGetReviewQueueRecord.mockImplementation(() =>
      Promise.resolve(
        makeQueueRecord({
          runningEvent: makeEvent(),
          runningPayload: { first: true },
          runningCommitSha: 'abc123',
          pendingEvent: null,
          pendingPayload: null,
          pendingCommitSha: null,
        }),
      ),
    )

    await enqueueReview({
      mastra: makeMastra(),
      project: makeProject(),
      payload: makePayload(),
      event,
    })

    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(mockUpsertPendingReviewRequest).not.toHaveBeenCalled()
    expect(mockSetPendingCommitSha).not.toHaveBeenCalled()
    expect(mockExecuteMrReview).not.toHaveBeenCalled()
    expect(mockSyncStatusNote).not.toHaveBeenCalled()
  })

  test('draining mode queues without starting a review', async () => {
    mockGetServiceRuntimeMode.mockImplementation(() => Promise.resolve('draining'))

    await enqueueReview({
      mastra: makeMastra(),
      project: makeProject(),
      payload: makePayload(),
      event: makeEvent(),
    })

    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(mockExecuteMrReview).not.toHaveBeenCalled()
    expect(
      statusInputs().some(
        (input) =>
          input.state === 'queued' &&
          input.message === 'Queued while service is draining for restart',
      ),
    ).toBe(true)
  })

  test('draining after a run leaves pending work queued instead of changing to queued early', async () => {
    const event = makeEvent()
    mockClaimPendingReviewJob
      .mockImplementationOnce(() =>
        Promise.resolve({
          id: 'test-project:42',
          projectKey: 'test-project',
          mrIid: 42,
          event,
          payload: makePayload(),
          commitSha: null,
        }),
      )
      .mockImplementation(() => Promise.resolve(null))
    const modeSequence: Array<'running' | 'draining'> = [
      'running',
      'running',
      'running',
      'running',
      'draining',
      'draining',
    ]
    mockGetServiceRuntimeMode.mockImplementation(() =>
      Promise.resolve(modeSequence.shift() ?? 'draining'),
    )
    mockFinishRunningReview.mockImplementation(() =>
      Promise.resolve(makeQueueRecord({ pendingEvent: event })),
    )

    await enqueueReview({
      mastra: makeMastra(),
      project: makeProject(),
      payload: makePayload(),
      event,
    })

    await new Promise((resolve) => setTimeout(resolve, 40))

    expect(
      statusInputs().some(
        (input) =>
          input.state === 'queued' &&
          input.message === 'Queued while service is draining for restart',
      ),
    ).toBe(true)
  })

  test('same-SHA pending update is dropped after the running review finishes', async () => {
    const event = makeEvent()
    mockClaimPendingReviewJob
      .mockImplementationOnce(() =>
        Promise.resolve({
          id: 'test-project:42',
          projectKey: 'test-project',
          mrIid: 42,
          event,
          payload: makePayload(),
          commitSha: 'abc123',
        }),
      )
      .mockImplementation(() => Promise.resolve(null))
    mockFinishRunningReview.mockImplementation(() =>
      Promise.resolve(
        makeQueueRecord({
          pendingEvent: makeEvent({ title: 'Updated title' }),
          pendingPayload: { second: true },
          pendingCommitSha: 'abc123',
        }),
      ),
    )

    await enqueueReview({
      mastra: makeMastra(),
      project: makeProject(),
      payload: makePayload(),
      event,
    })

    await new Promise((resolve) => setTimeout(resolve, 40))

    expect(mockExecuteMrReview).toHaveBeenCalledTimes(1)
    expect(mockDeleteReviewQueueRecord).toHaveBeenCalledWith('test-project:42')
  })

  test('failed status retains the active SHA when review execution throws', async () => {
    const event = makeEvent()
    mockClaimPendingReviewJob
      .mockImplementationOnce(() =>
        Promise.resolve({
          id: 'test-project:42',
          projectKey: 'test-project',
          mrIid: 42,
          event,
          payload: makePayload(),
          commitSha: null,
        }),
      )
      .mockImplementation(() => Promise.resolve(null))
    mockExecuteMrReview.mockImplementation(() => Promise.reject(new Error('boom')))

    await enqueueReview({
      mastra: makeMastra(),
      project: makeProject(),
      payload: makePayload(),
      event,
    })

    await new Promise((resolve) => setTimeout(resolve, 40))

    expect(
      statusInputs().some(
        (input) =>
          input.state === 'failed' && input.runningSha === 'abc123' && input.message === 'boom',
      ),
    ).toBe(true)
  })

  test('status-note sync failure on completion does not block the next queued event', async () => {
    const firstEvent = makeEvent({ title: 'First event' })
    const secondEvent = makeEvent({ title: 'Second event' })
    mockClaimPendingReviewJob
      .mockImplementationOnce(() =>
        Promise.resolve({
          id: 'test-project:42',
          projectKey: 'test-project',
          mrIid: 42,
          event: firstEvent,
          payload: makePayload('abc123'),
          commitSha: 'abc123',
        }),
      )
      .mockImplementationOnce(() =>
        Promise.resolve({
          id: 'test-project:42',
          projectKey: 'test-project',
          mrIid: 42,
          event: secondEvent,
          payload: makePayload('def456'),
          commitSha: 'def456',
        }),
      )
      .mockImplementation(() => Promise.resolve(null))
    mockFinishRunningReview
      .mockImplementationOnce(() =>
        Promise.resolve(
          makeQueueRecord({
            pendingEvent: secondEvent,
            pendingPayload: makePayload('def456'),
            pendingCommitSha: 'def456',
          }),
        ),
      )
      .mockImplementationOnce(() => Promise.resolve(null))
    mockSyncStatusNote.mockImplementation(async ({ input }) => input.state !== 'completed')

    await enqueueReview({
      mastra: makeMastra(),
      project: makeProject(),
      payload: makePayload('abc123'),
      event: firstEvent,
    })

    await waitForWorker()

    expect(mockExecuteMrReview).toHaveBeenCalledTimes(2)
    expect(mockFinishRunningReview).toHaveBeenCalledTimes(2)
    expect(statusInputs().filter((input) => input.state === 'completed')).toHaveLength(2)
  })

  test('worker restart check failure cleans up active worker without unhandled rejection', async () => {
    mockGetReviewQueueRecord
      .mockImplementationOnce(() => Promise.resolve(null))
      .mockImplementationOnce(() => Promise.reject(new Error('restart check failed')))

    await enqueueReview({
      mastra: makeMastra(),
      project: makeProject(),
      payload: makePayload(),
      event: makeEvent(),
    })

    await waitForWorker()

    expect(hasActiveReviewWorkers()).toBe(false)
  })
})

describe('persistent queue helpers', () => {
  test('recovers interrupted queue rows through db helper', async () => {
    mockRecoverReviewQueueAfterRestart.mockImplementation(() => Promise.resolve(2))

    await expect(recoverPersistedReviewQueue(queueDependencies())).resolves.toBe(2)
  })

  test('resumes persisted pending queue entries for known projects', async () => {
    const event = makeEvent()
    mockListReviewQueueRecords.mockImplementation(() =>
      Promise.resolve([
        makeQueueRecord({ pendingEvent: event }),
        makeQueueRecord({ id: 'unknown:1', projectKey: 'unknown', mrIid: 1, pendingEvent: event }),
      ]),
    )
    mockClaimPendingReviewJob
      .mockImplementationOnce(() =>
        Promise.resolve({
          id: 'test-project:42',
          projectKey: 'test-project',
          mrIid: 42,
          event,
          payload: makePayload(),
          commitSha: null,
        }),
      )
      .mockImplementation(() => Promise.resolve(null))

    const resumed = await resumePersistedReviewQueue(
      makeConfig(),
      makeMastra(),
      queueDependencies(),
    )
    await new Promise((resolve) => setTimeout(resolve, 40))

    expect(resumed).toBe(1)
    expect(mockExecuteMrReview).toHaveBeenCalledTimes(1)
    expect(mockDeleteReviewQueueRecord).toHaveBeenCalledWith('unknown:1')
  })

  test('does not count rows that are already running as resumable', async () => {
    const event = makeEvent()
    mockListReviewQueueRecords.mockImplementation(() =>
      Promise.resolve([
        makeQueueRecord({
          runningEvent: event,
          runningPayload: { a: 1 },
          runningCommitSha: 'abc123',
          pendingEvent: event,
          pendingPayload: { b: 2 },
          pendingCommitSha: 'abc123',
        }),
      ]),
    )

    const resumed = await resumePersistedReviewQueue(
      makeConfig(),
      makeMastra(),
      queueDependencies(),
    )
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(resumed).toBe(0)
    expect(mockClaimPendingReviewJob).not.toHaveBeenCalled()
    expect(mockExecuteMrReview).not.toHaveBeenCalled()
  })
})
