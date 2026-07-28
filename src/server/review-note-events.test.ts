import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { isNoteAddressedToMend, type IsNoteAddressedToMendParams } from '@/server/note-addressing'
import { deriveThreadContext } from '@/mastra/review/thread-context'
import {
  appendInlineMarkers,
  appendSummaryFindingMarkers,
  appendSummaryMarkers,
} from '@/mastra/review/markers'
import type { ProjectConfig } from '@/config'
import type { ReviewProvider } from '@/integrations/provider/client'
import type { ProviderThread, ProviderThreadMessage } from '@/integrations/provider/types'
import type { ReviewMessageRecord, ReviewThreadRecord } from '@/db/review-threads'
import type { ReviewMemoryEntryRecord, ReviewMemoryEventRecord } from '@/db/review-memory'
import type { ReviewFindingRecord } from '@/db/review-findings'

const BOT_USER_ID = 100

const baseParams: IsNoteAddressedToMendParams = {
  directMention: false,
  existingMendThread: false,
  lastExistingMessage: null,
  existingThreadMessageCount: 0,
  firstDiscussionNoteAuthorId: null,
  currentUserId: BOT_USER_ID,
}

describe('isNoteAddressedToMend', () => {
  test('direct mention returns true', () => {
    expect(isNoteAddressedToMend({ ...baseParams, directMention: true })).toBe(true)
  })

  test('reply in Mend thread where last message is from agent returns true', () => {
    expect(
      isNoteAddressedToMend({
        ...baseParams,
        existingMendThread: true,
        lastExistingMessage: { authorType: 'agent', processingStatus: null },
        existingThreadMessageCount: 2,
      }),
    ).toBe(true)
  })

  test('reply in Mend thread where last message is human (not pending/processing) returns false', () => {
    expect(
      isNoteAddressedToMend({
        ...baseParams,
        existingMendThread: true,
        lastExistingMessage: { authorType: 'human', processingStatus: 'completed' },
        existingThreadMessageCount: 2,
      }),
    ).toBe(false)
  })

  test('reply in bot-started discussion with no local thread returns true', () => {
    expect(
      isNoteAddressedToMend({
        ...baseParams,
        existingMendThread: false,
        firstDiscussionNoteAuthorId: BOT_USER_ID,
        existingThreadMessageCount: 0,
      }),
    ).toBe(true)
  })

  test('reply in unrelated discussion (no thread, first note not from bot) returns false', () => {
    expect(
      isNoteAddressedToMend({
        ...baseParams,
        existingMendThread: false,
        firstDiscussionNoteAuthorId: 999,
        existingThreadMessageCount: 0,
      }),
    ).toBe(false)
  })

  test('reply in Mend thread where last message processingStatus is pending returns true', () => {
    expect(
      isNoteAddressedToMend({
        ...baseParams,
        existingMendThread: true,
        lastExistingMessage: { authorType: 'human', processingStatus: 'pending' },
        existingThreadMessageCount: 2,
      }),
    ).toBe(true)
  })

  test('reply in Mend thread where last message processingStatus is processing returns true', () => {
    expect(
      isNoteAddressedToMend({
        ...baseParams,
        existingMendThread: true,
        lastExistingMessage: { authorType: 'human', processingStatus: 'processing' },
        existingThreadMessageCount: 2,
      }),
    ).toBe(true)
  })

  test('existing Mend thread with no persisted messages returns true', () => {
    expect(
      isNoteAddressedToMend({
        ...baseParams,
        existingMendThread: true,
        lastExistingMessage: null,
        existingThreadMessageCount: 0,
      }),
    ).toBe(true)
  })

  test('no existing thread, first note not from bot, no direct mention returns false', () => {
    expect(
      isNoteAddressedToMend({
        ...baseParams,
        existingMendThread: false,
        lastExistingMessage: null,
        existingThreadMessageCount: 0,
        firstDiscussionNoteAuthorId: 42,
      }),
    ).toBe(false)
  })
})

describe('deriveThreadContext', () => {
  test('extracts inline context from GitLab diff note position', () => {
    const context = deriveThreadContext({
      id: 'discussion-1',
      isThread: true,
      messages: [
        {
          id: '1',
          body: 'hello',
          author: { id: 1, username: 'dev', raw: {} },
          resolvable: true,
          resolved: false,
          createdAt: '2026-03-08T00:00:00.000Z',
          updatedAt: '2026-03-08T00:00:00.000Z',
          url: 'https://gitlab.example.com/note/1',
          position: {
            path: 'src/app.ts',
            oldPath: null,
            line: 42,
            oldLine: null,
          },
          raw: {},
        },
      ],
      raw: {},
    })

    expect(context.threadKind).toBe('inline')
    expect(context.subjectType).toBe('line')
    expect(context.path).toBe('src/app.ts')
    expect(context.line).toBe(42)
  })

  test('extracts inline context from Mend inline marker', () => {
    const markedBody = appendInlineMarkers('Guard check is missing.', 'run-123', 'src/utils.ts', 10)
    const context = deriveThreadContext({
      id: 'discussion-2',
      isThread: true,
      messages: [
        {
          id: '2',
          body: markedBody,
          author: { id: 100, username: 'mend-bot', raw: {} },
          resolvable: true,
          resolved: false,
          createdAt: '2026-03-08T00:00:00.000Z',
          updatedAt: '2026-03-08T00:00:00.000Z',
          url: 'https://gitlab.example.com/note/2',
          position: null,
          raw: {},
        },
      ],
      raw: {},
    })

    expect(context.threadKind).toBe('inline')
    expect(context.subjectType).toBe('line')
    expect(context.path).toBe('src/utils.ts')
    expect(context.line).toBe(10)
    expect(context.findingFingerprint).toContain('src/utils.ts:10:')
  })

  test('extracts summary context from Mend summary marker', () => {
    const markedBody = appendSummaryMarkers('Review summary text.', 'run-456')
    const context = deriveThreadContext({
      id: 'discussion-3',
      isThread: true,
      messages: [
        {
          id: '3',
          body: markedBody,
          author: { id: 100, username: 'mend-bot', raw: {} },
          resolvable: false,
          resolved: false,
          createdAt: '2026-03-08T00:00:00.000Z',
          updatedAt: '2026-03-08T00:00:00.000Z',
          url: 'https://gitlab.example.com/note/3',
          position: null,
          raw: {},
        },
      ],
      raw: {},
    })

    expect(context.threadKind).toBe('summary_note')
    expect(context.subjectType).toBe('general')
    expect(context.path).toBeNull()
    expect(context.line).toBeNull()
    expect(context.findingFingerprint).toBe('summary:discussion-3')
  })

  test('extracts summary finding context from Mend summary finding marker', () => {
    const markedBody = appendSummaryFindingMarkers('Finding thread text.', 'run-789', {
      fingerprint: 'summary_finding:dup-layout',
      previousFindingId: 'dup-layout',
      path: 'src/app.ts',
      line: 21,
    })
    const context = deriveThreadContext({
      id: 'discussion-5',
      isThread: true,
      messages: [
        {
          id: '5',
          body: markedBody,
          author: { id: 100, username: 'mend-bot', raw: {} },
          resolvable: true,
          resolved: false,
          createdAt: '2026-03-08T00:00:00.000Z',
          updatedAt: '2026-03-08T00:00:00.000Z',
          url: 'https://gitlab.example.com/note/5',
          position: null,
          raw: {},
        },
      ],
      raw: {},
    })

    expect(context.threadKind).toBe('summary_finding')
    expect(context.subjectType).toBe('line')
    expect(context.path).toBe('src/app.ts')
    expect(context.line).toBe(21)
    expect(context.findingFingerprint).toBe('summary_finding:dup-layout')
  })

  test('returns conversation context for notes without markers or position', () => {
    const context = deriveThreadContext({
      id: 'discussion-4',
      isThread: true,
      messages: [
        {
          id: '4',
          body: 'A general comment with no position data.',
          author: { id: 1, username: 'dev', raw: {} },
          resolvable: false,
          resolved: false,
          createdAt: '2026-03-08T00:00:00.000Z',
          updatedAt: '2026-03-08T00:00:00.000Z',
          url: 'https://gitlab.example.com/note/4',
          position: null,
          raw: {},
        },
      ],
      raw: {},
    })

    expect(context.threadKind).toBe('conversation')
    expect(context.subjectType).toBe('general')
    expect(context.path).toBeNull()
    expect(context.line).toBeNull()
    expect(context.findingFingerprint).toBeNull()
  })
})

const mockFetchCurrentUser = mock(() => Promise.resolve({ id: 100, username: 'mend-bot' }))
const mockGetThread = mock<(...args: unknown[]) => Promise<ProviderThread>>(() =>
  Promise.resolve(makeDiscussion()),
)
const mockListThreads = mock<(...args: unknown[]) => Promise<ProviderThread[]>>(() =>
  Promise.resolve([]),
)
const mockCreateThread = mock<(...args: unknown[]) => Promise<ProviderThread>>(() =>
  Promise.resolve(makeDiscussion()),
)
const mockReplyToThread = mock<(...args: unknown[]) => Promise<ProviderThreadMessage>>(() =>
  Promise.resolve(makeReplyNote()),
)
const mockResolveThread = mock(() => Promise.resolve(true))
const mockAddNoteReaction = mock(() => Promise.resolve())
const mockAddThreadMessageReaction = mock(() => Promise.resolve())
const mockCreateReviewProvider = mock<() => ReviewProvider>(() => ({
  kind: 'gitlab',
  fetchCurrentUser: mockFetchCurrentUser,
  fetchChangeRequest: mock(async () => {
    throw new Error('unused')
  }),
  fetchDiffRefs: mock(async () => ({ baseSha: 'base', headSha: 'head', startSha: 'start' })),
  fetchChangedFiles: mock(async () => []),
  listNotes: mock(async () => []),
  createNote: mock(async () => ({ id: 1, body: '', author: null })),
  updateNote: mock(async () => ({ id: 1, body: '', author: null })),
  deleteNote: mock(async () => {}),
  listThreads: mockListThreads,
  getThread: mockGetThread,
  createThread: mockCreateThread,
  replyToThread: mockReplyToThread,
  resolveThread: mockResolveThread,
  addNoteReaction: mockAddNoteReaction,
  addThreadMessageReaction: mockAddThreadMessageReaction,
  publishReviewBatch: mock(async () => ({
    preExistingDraftCount: 0,
    recoveredDraftCount: 0,
    draftRecoveryAction: 'none' as const,
    summaryNoteId: 1,
    summaryReconciled: false,
  })),
}))

mock.module('@/integrations/provider/client', () => ({
  createReviewProvider: mockCreateReviewProvider,
}))

const addedReactionNames = (): string[] =>
  mockAddThreadMessageReaction.mock.calls
    .map((call) => (call as unknown[])[2])
    .filter((value): value is string => typeof value === 'string')

const mockGetReviewThreadByProviderThreadId = mock<
  (...args: unknown[]) => Promise<ReviewThreadRecord | null>
>(() => Promise.resolve(null))
const mockListReviewMessagesForThread = mock<
  (...args: unknown[]) => Promise<ReviewMessageRecord[]>
>(() => Promise.resolve([]))
const mockUpsertReviewThread = mock<(...args: unknown[]) => Promise<ReviewThreadRecord>>(() =>
  Promise.resolve(makeThread()),
)
const mockUpsertReviewMessage = mock<(...args: unknown[]) => Promise<ReviewMessageRecord>>(() =>
  Promise.resolve(makeMessage()),
)
const mockCreateReviewMessageIfAbsent = mock<
  (...args: unknown[]) => Promise<ReviewMessageRecord | null>
>(() => Promise.resolve(makeMessage()))
const mockGetReviewMessageByProviderMessageId = mock<
  (...args: unknown[]) => Promise<ReviewMessageRecord | null>
>(() => Promise.resolve(null))
const mockClaimPendingReviewMessage = mock<(...args: unknown[]) => Promise<boolean>>(() =>
  Promise.resolve(false),
)
const mockCompleteReviewMessageProcessing = mock(() => Promise.resolve())
const mockResetReviewMessageProcessing = mock(() => Promise.resolve())
const mockUpdateReviewThreadStatusByProviderThreadId = mock(() => Promise.resolve())

mock.module('@/db/review-threads', () => ({
  getReviewThreadByProviderThreadId: mockGetReviewThreadByProviderThreadId,
  listReviewMessagesForThread: mockListReviewMessagesForThread,
  upsertReviewThread: mockUpsertReviewThread,
  upsertReviewMessage: mockUpsertReviewMessage,
  createReviewMessageIfAbsent: mockCreateReviewMessageIfAbsent,
  getReviewMessageByProviderMessageId: mockGetReviewMessageByProviderMessageId,
  claimPendingReviewMessage: mockClaimPendingReviewMessage,
  completeReviewMessageProcessing: mockCompleteReviewMessageProcessing,
  resetReviewMessageProcessing: mockResetReviewMessageProcessing,
  updateReviewThreadStatusByProviderThreadId: mockUpdateReviewThreadStatusByProviderThreadId,
}))

const mockGetReviewFindingByThreadId = mock<
  (...args: unknown[]) => Promise<ReviewFindingRecord | null>
>(() => Promise.resolve(null))
const mockUpdateReviewFindingState = mock<
  (...args: unknown[]) => Promise<ReviewFindingRecord | null>
>(() => Promise.resolve(null))

mock.module('@/db/review-findings', () => ({
  getReviewFindingByThreadId: mockGetReviewFindingByThreadId,
  updateReviewFindingState: mockUpdateReviewFindingState,
  listReviewFindingsForMr: mock(() => Promise.resolve([])),
  countReviewFindingsByStateForMr: mock(() =>
    Promise.resolve({ pending: 0, accepted: 0, rejected: 0, deferred: 0 }),
  ),
  countReviewFindingSeveritiesForMr: mock(() =>
    Promise.resolve({ bug: 0, security: 0, performance: 0, suggestion: 0 }),
  ),
  getReviewFindingByProviderThreadId: mock(() => Promise.resolve(null)),
  upsertReviewFinding: mock(() => Promise.resolve(makeFinding())),
}))

const mockCreateReviewMemoryEntry = mock<(...args: unknown[]) => Promise<ReviewMemoryEntryRecord>>(
  () => Promise.resolve(makeMemoryEntry()),
)
const mockCreateReviewMemoryEvent = mock<(...args: unknown[]) => Promise<ReviewMemoryEventRecord>>(
  () => Promise.resolve(makeMemoryEvent()),
)
const mockArchiveActiveMemoryForThread = mock(() => Promise.resolve())

mock.module('@/db/review-memory', () => ({
  createReviewMemoryEntry: mockCreateReviewMemoryEntry,
  createReviewMemoryEvent: mockCreateReviewMemoryEvent,
  archiveActiveMemoryForThread: mockArchiveActiveMemoryForThread,
}))

const mockGetLatestSuccessfulReviewRun = mock<(...args: unknown[]) => Promise<unknown>>(() =>
  Promise.resolve(null),
)
const mockGetReviewRun = mock<(...args: unknown[]) => Promise<unknown>>(() => Promise.resolve(null))

mock.module('@/db/review-runs', () => ({
  getLatestSuccessfulReviewRun: mockGetLatestSuccessfulReviewRun,
  getReviewRun: mockGetReviewRun,
  createReviewRun: mock(() => Promise.resolve()),
  completeReviewRun: mock(() => Promise.resolve()),
  failReviewRun: mock(() => Promise.resolve()),
  countPostedSuccessfulReviewRuns: mock(() => Promise.resolve(0)),
  hasSuccessfulReviewRunForSha: mock(() => Promise.resolve(false)),
  listReviewRuns: mock(() => Promise.resolve([])),
  updateReviewRunResult: mock(() => Promise.resolve()),
}))

const mockGenerateThreadReply = mock<(...args: unknown[]) => Promise<string>>(() =>
  Promise.resolve('LLM-generated reply about the code.'),
)

mock.module('@/server/review-thread-reply', () => ({
  generateThreadReply: mockGenerateThreadReply,
}))

const mockRequestAcceptedFixBatch = mock(() =>
  Promise.resolve({
    status: 'queued' as const,
    batch: {},
    acceptedCount: 1,
    pendingCount: 0,
    waitingForReview: false,
  }),
)

mock.module('@/server/fix-batch-queue', () => ({
  requestAcceptedFixBatch: mockRequestAcceptedFixBatch,
}))

const { processGitlabMergeRequestNote, setReviewNoteEventsThreadSyncDependenciesForTest } =
  await import('@/server/review-note-events')

setReviewNoteEventsThreadSyncDependenciesForTest({
  getReviewThreadByProviderThreadId: mockGetReviewThreadByProviderThreadId,
  updateReviewThreadStatusByProviderThreadId: mockUpdateReviewThreadStatusByProviderThreadId,
  upsertReviewMessage: mockUpsertReviewMessage,
  upsertReviewThread: mockUpsertReviewThread,
})

const makeProject = (fix: Partial<ProjectConfig['review']['fix']> = {}): ProjectConfig => ({
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
    memory: { project_scope_usernames: ['trusted-user'] },
    triage: { trusted_usernames: [] },
    fix: { enabled: false, automatic: false, max_loops: 3, ...fix },
  },
  tools: { context7: {} },
})

const makeNotePayload = (overrides: Record<string, unknown> = {}) => ({
  project: { id: 1 },
  user: { id: 200, username: 'developer' },
  merge_request: { iid: 42 },
  object_attributes: {
    id: 999,
    note: 'This is a false positive.',
    noteable_type: 'MergeRequest',
    discussion_id: 'discussion-abc',
    action: 'create',
    url: 'https://gitlab.example.com/note/999',
    ...overrides,
  },
})

const makeBotNote = (overrides: Partial<ProviderThreadMessage> = {}): ProviderThreadMessage => ({
  id: '500',
  body: 'Original review comment from bot',
  author: { id: 100, username: 'mend-bot', raw: {} },
  resolvable: true,
  resolved: false,
  createdAt: '2026-03-08T00:00:00.000Z',
  updatedAt: '2026-03-08T00:00:00.000Z',
  url: 'https://gitlab.example.com/note/500',
  position: { path: 'src/app.ts', oldPath: null, line: 42, oldLine: null },
  raw: {},
  ...overrides,
})

const makeHumanNote = (overrides: Partial<ProviderThreadMessage> = {}): ProviderThreadMessage => ({
  id: '999',
  body: 'This is a false positive.',
  author: { id: 200, username: 'developer', raw: {} },
  resolvable: true,
  resolved: false,
  createdAt: '2026-03-09T00:00:00.000Z',
  updatedAt: '2026-03-09T00:00:00.000Z',
  url: 'https://gitlab.example.com/note/999',
  position: { path: 'src/app.ts', oldPath: null, line: 42, oldLine: null },
  raw: {},
  ...overrides,
})

const makeDiscussion = (
  overrides: Partial<ProviderThread> & { messages?: ProviderThreadMessage[] } = {},
): ProviderThread => ({
  id: 'discussion-abc',
  isThread: true,
  messages: [makeBotNote(), makeHumanNote()],
  raw: {},
  ...overrides,
})

const makeReplyNote = (overrides: Partial<ProviderThreadMessage> = {}): ProviderThreadMessage => ({
  id: '1001',
  body: 'Reply from bot',
  author: { id: 100, username: 'mend-bot', raw: {} },
  resolvable: true,
  resolved: false,
  createdAt: '2026-03-09T01:00:00.000Z',
  updatedAt: '2026-03-09T01:00:00.000Z',
  url: 'https://gitlab.example.com/note/1001',
  position: null,
  raw: {},
  ...overrides,
})

const makeThread = (overrides: Partial<ReviewThreadRecord> = {}): ReviewThreadRecord => ({
  id: 'thread-1',
  provider: 'gitlab',
  projectKey: 'test-project',
  repoExternalId: '1',
  reviewExternalId: 42,
  reviewRunId: null,
  threadKind: 'inline',
  subjectType: 'line',
  path: 'src/app.ts',
  line: 42,
  findingFingerprint: null,
  status: 'open',
  providerThreadId: 'discussion-abc',
  providerUrl: 'https://gitlab.example.com/note/500',
  rawProviderData: {},
  providerCreatedAt: new Date('2026-03-08T00:00:00.000Z'),
  providerUpdatedAt: new Date('2026-03-08T00:00:00.000Z'),
  createdAt: new Date('2026-03-08T00:00:00.000Z'),
  updatedAt: new Date('2026-03-08T00:00:00.000Z'),
  ...overrides,
})

const makeFinding = (overrides: Partial<ReviewFindingRecord> = {}): ReviewFindingRecord => ({
  id: 'finding-1',
  projectKey: 'test-project',
  mrIid: 42,
  reviewRunId: 'run-1',
  threadId: 'thread-1',
  provider: 'gitlab',
  providerThreadId: 'discussion-abc',
  providerNoteId: '500',
  state: 'pending',
  decisionReason: null,
  decidedByExternalId: null,
  decidedByName: null,
  decidedAt: null,
  metadata: null,
  createdAt: new Date('2026-03-08T00:00:00.000Z'),
  updatedAt: new Date('2026-03-08T00:00:00.000Z'),
  ...overrides,
})

const makeMessage = (overrides: Partial<ReviewMessageRecord> = {}): ReviewMessageRecord => ({
  id: 'msg-1',
  threadId: 'thread-1',
  provider: 'gitlab',
  reviewRunId: null,
  authorType: 'human',
  authorExternalId: '200',
  authorName: 'developer',
  direction: 'inbound',
  body: 'This is a false positive.',
  bodyNormalized: 'this is a false positive.',
  providerMessageId: '999',
  providerParentMessageId: null,
  processingStatus: 'processing',
  processingClaimedAt: new Date(),
  providerUrl: 'https://gitlab.example.com/note/999',
  rawProviderData: {},
  providerCreatedAt: new Date('2026-03-09T00:00:00.000Z'),
  providerUpdatedAt: new Date('2026-03-09T00:00:00.000Z'),
  createdAt: new Date('2026-03-09T00:00:00.000Z'),
  updatedAt: new Date('2026-03-09T00:00:00.000Z'),
  ...overrides,
})

const makeAgentMessage = (overrides: Partial<ReviewMessageRecord> = {}): ReviewMessageRecord =>
  makeMessage({
    id: 'msg-agent-1',
    authorType: 'agent',
    authorExternalId: '100',
    authorName: 'mend-bot',
    direction: 'outbound',
    body: 'Original review comment from bot',
    bodyNormalized: 'original review comment from bot',
    providerMessageId: '500',
    ...overrides,
  })

const makeMemoryEntry = (
  overrides: Partial<ReviewMemoryEntryRecord> = {},
): ReviewMemoryEntryRecord => ({
  id: 'memory-1',
  scope: 'mr',
  status: 'active',
  projectKey: 'test-project',
  mrIid: 42,
  threadId: 'thread-1',
  sourceMessageId: 'msg-1',
  kind: 'false_positive',
  instruction: 'Do not re-raise this concern.',
  matchFingerprint: null,
  matchPath: 'src/app.ts',
  matchLine: 42,
  matchCategory: null,
  metadata: {},
  createdByExternalId: '200',
  createdByName: 'developer',
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
})

const makeMemoryEvent = (
  overrides: Partial<ReviewMemoryEventRecord> = {},
): ReviewMemoryEventRecord => ({
  id: 'event-1',
  memoryEntryId: null,
  projectKey: 'test-project',
  mrIid: 42,
  threadId: 'thread-1',
  messageId: 'msg-1',
  eventType: 'created',
  payload: {},
  createdAt: new Date(),
  ...overrides,
})

const setupMendOwnedThread = (
  discussion: ProviderThread,
  agentMessages: ReviewMessageRecord[] = [makeAgentMessage()],
) => {
  const thread = makeThread()
  mockGetReviewThreadByProviderThreadId.mockImplementation(() => Promise.resolve(thread))
  mockListReviewMessagesForThread.mockImplementation(() => Promise.resolve(agentMessages))
  mockGetThread.mockImplementation(() => Promise.resolve(discussion))
  mockUpsertReviewThread.mockImplementation(() => Promise.resolve(thread))
  mockCreateReviewMessageIfAbsent.mockImplementation(() => Promise.resolve(makeMessage()))
  return thread
}

describe('processGitlabMergeRequestNote', () => {
  beforeEach(() => {
    mockFetchCurrentUser.mockReset()
    mockGetThread.mockReset()
    mockListThreads.mockReset()
    mockReplyToThread.mockReset()
    mockResolveThread.mockReset()
    mockAddNoteReaction.mockReset()
    mockAddThreadMessageReaction.mockReset()
    mockGetReviewThreadByProviderThreadId.mockReset()
    mockListReviewMessagesForThread.mockReset()
    mockUpsertReviewThread.mockReset()
    mockUpsertReviewMessage.mockReset()
    mockCreateReviewMessageIfAbsent.mockReset()
    mockGetReviewMessageByProviderMessageId.mockReset()
    mockClaimPendingReviewMessage.mockReset()
    mockCompleteReviewMessageProcessing.mockReset()
    mockResetReviewMessageProcessing.mockReset()
    mockUpdateReviewThreadStatusByProviderThreadId.mockReset()
    mockGetReviewFindingByThreadId.mockReset()
    mockUpdateReviewFindingState.mockReset()
    mockCreateReviewMemoryEntry.mockReset()
    mockCreateReviewMemoryEvent.mockReset()
    mockArchiveActiveMemoryForThread.mockReset()
    mockGetLatestSuccessfulReviewRun.mockReset()
    mockGetReviewRun.mockReset()
    mockGenerateThreadReply.mockReset()
    mockRequestAcceptedFixBatch.mockReset()

    mockFetchCurrentUser.mockImplementation(() =>
      Promise.resolve({ id: 100, username: 'mend-bot' }),
    )
    mockGetThread.mockImplementation(() => Promise.resolve(makeDiscussion()))
    mockListThreads.mockImplementation(() => Promise.resolve([]))
    mockReplyToThread.mockImplementation(() => Promise.resolve(makeReplyNote()))
    mockResolveThread.mockImplementation(() => Promise.resolve(true))
    mockAddNoteReaction.mockImplementation(() => Promise.resolve())
    mockAddThreadMessageReaction.mockImplementation(() => Promise.resolve())
    mockGetReviewThreadByProviderThreadId.mockImplementation(() => Promise.resolve(null))
    mockListReviewMessagesForThread.mockImplementation(() => Promise.resolve([]))
    mockUpsertReviewThread.mockImplementation(() => Promise.resolve(makeThread()))
    mockUpsertReviewMessage.mockImplementation(() => Promise.resolve(makeMessage()))
    mockCreateReviewMessageIfAbsent.mockImplementation(() => Promise.resolve(makeMessage()))
    mockGetReviewMessageByProviderMessageId.mockImplementation(() => Promise.resolve(null))
    mockClaimPendingReviewMessage.mockImplementation(() => Promise.resolve(false))
    mockCompleteReviewMessageProcessing.mockImplementation(() => Promise.resolve())
    mockResetReviewMessageProcessing.mockImplementation(() => Promise.resolve())
    mockUpdateReviewThreadStatusByProviderThreadId.mockImplementation(() => Promise.resolve())
    mockGetReviewFindingByThreadId.mockImplementation(() => Promise.resolve(null))
    mockUpdateReviewFindingState.mockImplementation(() => Promise.resolve(makeFinding()))
    mockCreateReviewMemoryEntry.mockImplementation(() => Promise.resolve(makeMemoryEntry()))
    mockCreateReviewMemoryEvent.mockImplementation(() => Promise.resolve(makeMemoryEvent()))
    mockArchiveActiveMemoryForThread.mockImplementation(() => Promise.resolve())
    mockGetLatestSuccessfulReviewRun.mockImplementation(() => Promise.resolve(null))
    mockGetReviewRun.mockImplementation(() => Promise.resolve(null))
    mockGenerateThreadReply.mockImplementation(() =>
      Promise.resolve('LLM-generated reply about the code.'),
    )
    mockRequestAcceptedFixBatch.mockImplementation(() =>
      Promise.resolve({
        status: 'queued' as const,
        batch: {},
        acceptedCount: 1,
        pendingCount: 0,
        waitingForReview: false,
      }),
    )
  })

  test('skips self-authored notes silently', async () => {
    const payload = makeNotePayload({ id: 999 })
    payload.user = { id: 100, username: 'mend-bot' }

    await processGitlabMergeRequestNote({ project: makeProject({ enabled: true }), payload })

    expect(mockGetThread).not.toHaveBeenCalled()
    expect(mockCreateReviewMessageIfAbsent).not.toHaveBeenCalled()
    expect(mockAddThreadMessageReaction).not.toHaveBeenCalled()
  })

  test('skips non-MR notes', async () => {
    const payload = makeNotePayload({ noteable_type: 'Issue' })

    await processGitlabMergeRequestNote({ project: makeProject({ enabled: true }), payload })

    expect(mockFetchCurrentUser).not.toHaveBeenCalled()
    expect(mockGetThread).not.toHaveBeenCalled()
  })

  test('skips non-create note actions', async () => {
    const payload = makeNotePayload({ action: 'update' })

    await processGitlabMergeRequestNote({ project: makeProject({ enabled: true }), payload })

    expect(mockGetThread).not.toHaveBeenCalled()
    expect(mockCreateReviewMessageIfAbsent).not.toHaveBeenCalled()
    expect(mockAddThreadMessageReaction).not.toHaveBeenCalled()
  })

  test('skips API fetch when thread exists locally with reviewRunId and outbound message', async () => {
    const discussion = makeDiscussion()
    setupMendOwnedThread(discussion)
    mockGetReviewThreadByProviderThreadId.mockImplementation(() =>
      Promise.resolve(makeThread({ reviewRunId: 'run-1' })),
    )

    const payload = makeNotePayload({ note: 'This is a false positive.' })

    await processGitlabMergeRequestNote({ project: makeProject(), payload })

    expect(mockGetThread).not.toHaveBeenCalled()
    expect(mockListThreads).not.toHaveBeenCalled()
  })

  test('fetches single discussion when discussion_id is present but no local thread', async () => {
    const discussion = makeDiscussion()
    mockGetThread.mockImplementation(() => Promise.resolve(discussion))

    const payload = makeNotePayload({ note: 'This is a false positive.' })

    await processGitlabMergeRequestNote({ project: makeProject(), payload })

    expect(mockGetThread).toHaveBeenCalledTimes(1)
    expect(mockListThreads).not.toHaveBeenCalled()
  })

  test('falls back to listThreads when discussion_id is absent', async () => {
    const discussion = makeDiscussion()
    mockListThreads.mockImplementation(() => Promise.resolve([discussion]))

    const payload = makeNotePayload({ note: 'This is a false positive.' })
    delete (payload.object_attributes as Record<string, unknown>).discussion_id

    await processGitlabMergeRequestNote({ project: makeProject(), payload })

    expect(mockGetThread).not.toHaveBeenCalled()
    expect(mockListThreads).toHaveBeenCalledTimes(1)
  })

  test('adds reactions through general note endpoint when discussion_id is absent', async () => {
    const discussion = makeDiscussion()
    mockListThreads.mockImplementation(() => Promise.resolve([discussion]))

    const payload = makeNotePayload({ note: 'This is a false positive.' })
    delete (payload.object_attributes as Record<string, unknown>).discussion_id

    await processGitlabMergeRequestNote({ project: makeProject(), payload })

    expect(mockAddNoteReaction).toHaveBeenCalledWith(42, 999, 'eyes')
    expect(mockAddNoteReaction).toHaveBeenCalledWith(42, 999, 'white_check_mark')
    expect(mockAddThreadMessageReaction).not.toHaveBeenCalled()
  })

  test('adds reactions through thread message endpoint when discussion_id is present', async () => {
    const discussion = makeDiscussion()
    setupMendOwnedThread(discussion)

    const payload = makeNotePayload({ note: 'This is a false positive.' })

    await processGitlabMergeRequestNote({ project: makeProject(), payload })

    expect(mockAddThreadMessageReaction).toHaveBeenCalledWith(42, 999, 'eyes')
    expect(mockAddThreadMessageReaction).toHaveBeenCalledWith(42, 999, 'white_check_mark')
    expect(mockAddNoteReaction).not.toHaveBeenCalled()
  })

  test('adds reactions through thread message endpoint for DiffNote type without discussion_id', async () => {
    const discussion = makeDiscussion()
    mockListThreads.mockImplementation(() => Promise.resolve([discussion]))

    const payload = makeNotePayload({ discussion_id: null, type: 'DiffNote' })

    await processGitlabMergeRequestNote({ project: makeProject(), payload })

    expect(mockAddThreadMessageReaction).toHaveBeenCalledWith(42, 999, 'eyes')
    expect(mockAddThreadMessageReaction).toHaveBeenCalledWith(42, 999, 'white_check_mark')
    expect(mockAddNoteReaction).not.toHaveBeenCalled()
  })

  test('accept command updates the persisted finding decision only', async () => {
    const discussion = makeDiscussion({
      messages: [makeBotNote(), makeHumanNote({ body: '@mend accept' })],
    })
    setupMendOwnedThread(discussion)
    mockGetReviewFindingByThreadId.mockImplementation(() => Promise.resolve(makeFinding()))

    const payload = makeNotePayload({ note: '@mend accept' })

    await processGitlabMergeRequestNote({ project: makeProject(), payload })

    expect(mockUpdateReviewFindingState).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'finding-1',
        state: 'accepted',
        decisionReason: null,
        decidedByExternalId: '200',
        decidedByName: 'developer',
      }),
    )
    expect(mockCreateReviewMemoryEntry).not.toHaveBeenCalled()
    expect(mockReplyToThread).not.toHaveBeenCalled()
    expect(mockAddThreadMessageReaction).toHaveBeenCalledWith(42, 999, 'white_check_mark')
    expect(mockCompleteReviewMessageProcessing).toHaveBeenCalled()
  })

  test('reject command uses a default reason when omitted', async () => {
    const discussion = makeDiscussion({
      messages: [makeBotNote(), makeHumanNote({ body: '@mend reject' })],
    })
    setupMendOwnedThread(discussion)
    mockGetReviewFindingByThreadId.mockImplementation(() => Promise.resolve(makeFinding()))

    const payload = makeNotePayload({ note: '@mend reject' })

    await processGitlabMergeRequestNote({ project: makeProject(), payload })

    expect(mockUpdateReviewFindingState).toHaveBeenCalledWith(
      expect.objectContaining({
        state: 'rejected',
        decisionReason: 'Rejected by human triage.',
      }),
    )
    expect(mockReplyToThread).toHaveBeenCalledWith(
      42,
      'discussion-abc',
      'Marked as rejected: Rejected by human triage.',
    )
    expect(mockResolveThread).toHaveBeenCalledWith(42, 'discussion-abc')
    expect(mockUpdateReviewThreadStatusByProviderThreadId).toHaveBeenCalledWith({
      provider: 'gitlab',
      providerThreadId: 'discussion-abc',
      status: 'resolved',
    })
  })

  test('does not mark a triage thread resolved when the provider cannot resolve it', async () => {
    const discussion = makeDiscussion({
      messages: [makeBotNote(), makeHumanNote({ body: '@mend reject' })],
    })
    setupMendOwnedThread(discussion)
    mockGetReviewFindingByThreadId.mockImplementation(() => Promise.resolve(makeFinding()))
    mockResolveThread.mockImplementation(() => Promise.resolve(false))

    const payload = makeNotePayload({ note: '@mend reject' })

    await processGitlabMergeRequestNote({ project: makeProject(), payload })

    expect(mockReplyToThread).toHaveBeenCalledTimes(1)
    expect(mockResolveThread).toHaveBeenCalledWith(42, 'discussion-abc')
    expect(mockUpdateReviewThreadStatusByProviderThreadId).not.toHaveBeenCalled()
  })

  test('defer command requires a reason before updating a finding', async () => {
    const discussion = makeDiscussion({
      messages: [makeBotNote(), makeHumanNote({ body: '@mend defer' })],
    })
    setupMendOwnedThread(discussion)
    mockGetReviewFindingByThreadId.mockImplementation(() => Promise.resolve(makeFinding()))

    const payload = makeNotePayload({ note: '@mend defer' })

    await processGitlabMergeRequestNote({ project: makeProject(), payload })

    expect(mockUpdateReviewFindingState).not.toHaveBeenCalled()
    expect(mockReplyToThread).not.toHaveBeenCalled()
    expect(addedReactionNames()).not.toContain('white_check_mark')
    expect(mockCompleteReviewMessageProcessing).toHaveBeenCalled()
  })

  test('defer command stores the provided reason', async () => {
    const discussion = makeDiscussion({
      messages: [makeBotNote(), makeHumanNote({ body: '@mend defer waiting for API contract' })],
    })
    setupMendOwnedThread(discussion)
    mockGetReviewFindingByThreadId.mockImplementation(() => Promise.resolve(makeFinding()))

    const payload = makeNotePayload({ note: '@mend defer waiting for API contract' })

    await processGitlabMergeRequestNote({ project: makeProject(), payload })

    expect(mockUpdateReviewFindingState).toHaveBeenCalledWith(
      expect.objectContaining({
        state: 'deferred',
        decisionReason: 'waiting for API contract',
      }),
    )
    expect(mockReplyToThread).toHaveBeenCalledWith(
      42,
      'discussion-abc',
      'Deferred: waiting for API contract',
    )
    expect(mockResolveThread).toHaveBeenCalledWith(42, 'discussion-abc')
  })

  test('command on a thread without a persisted finding does not mutate finding state', async () => {
    const discussion = makeDiscussion({
      messages: [makeBotNote(), makeHumanNote({ body: '@mend accept' })],
    })
    setupMendOwnedThread(discussion)
    mockGetReviewFindingByThreadId.mockImplementation(() => Promise.resolve(null))

    const payload = makeNotePayload({ note: '@mend accept' })

    await processGitlabMergeRequestNote({ project: makeProject(), payload })

    expect(mockUpdateReviewFindingState).not.toHaveBeenCalled()
    expect(addedReactionNames()).not.toContain('white_check_mark')
    expect(mockCompleteReviewMessageProcessing).toHaveBeenCalled()
  })

  test('fix accepted command queues an accepted finding batch', async () => {
    const discussion = makeDiscussion({
      messages: [makeBotNote(), makeHumanNote({ body: '@mend fix accepted' })],
    })
    setupMendOwnedThread(discussion)

    const payload = makeNotePayload({ note: '@mend fix accepted' })

    await processGitlabMergeRequestNote({ project: makeProject({ enabled: true }), payload })

    expect(mockRequestAcceptedFixBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        projectKey: 'test-project',
        mrIid: 42,
        enabled: true,
        force: false,
        requestNoteId: '999',
        requestThreadId: 'thread-1',
        requestedByExternalId: '200',
        requestedByName: 'developer',
      }),
    )
    expect(mockUpdateReviewFindingState).not.toHaveBeenCalled()
    expect(mockCreateReviewMemoryEntry).not.toHaveBeenCalled()
    expect(mockReplyToThread).not.toHaveBeenCalled()
    expect(mockAddThreadMessageReaction).toHaveBeenCalledWith(42, 999, 'white_check_mark')
    expect(mockCompleteReviewMessageProcessing).toHaveBeenCalled()
  })

  test('processes false positive dismissal in Mend-owned thread — creates MR memory, no reply', async () => {
    const discussion = makeDiscussion()
    setupMendOwnedThread(discussion)

    const payload = makeNotePayload({ note: 'This is a false positive.' })

    await processGitlabMergeRequestNote({ project: makeProject(), payload })

    expect(mockAddThreadMessageReaction).toHaveBeenCalledWith(42, 999, 'eyes')

    expect(mockCreateReviewMemoryEntry).toHaveBeenCalledTimes(1)
    const memoryCall = mockCreateReviewMemoryEntry.mock.calls[0]![0] as Record<string, unknown>
    expect(memoryCall.scope).toBe('mr')
    expect(memoryCall.kind).toBe('false_positive')

    expect(mockReplyToThread).not.toHaveBeenCalled()

    expect(mockAddThreadMessageReaction).toHaveBeenCalledWith(42, 999, 'white_check_mark')

    expect(mockCompleteReviewMessageProcessing).toHaveBeenCalled()
  })

  test('processes ambiguous dismissal with clarification reply — no memory, no success reaction', async () => {
    const discussion = makeDiscussion({
      messages: [makeBotNote(), makeHumanNote({ body: 'This is fine.' })],
    })
    setupMendOwnedThread(discussion)
    const payload = makeNotePayload({ note: 'This is fine.' })

    await processGitlabMergeRequestNote({ project: makeProject(), payload })

    expect(mockAddThreadMessageReaction).toHaveBeenCalledWith(42, 999, 'eyes')

    expect(mockReplyToThread).toHaveBeenCalledTimes(1)
    const replyCall = mockReplyToThread.mock.calls[0] as unknown[]
    const replyBody = replyCall[2] as string
    expect(replyBody).toContain('Should I remember this just for this merge request')

    expect(mockCreateReviewMemoryEntry).not.toHaveBeenCalled()

    const reactionNames = (mockAddThreadMessageReaction.mock.calls as unknown[][]).map(
      (call) => (call[1] as Record<string, unknown>).name,
    )
    expect(reactionNames).not.toContain('white_check_mark')

    expect(mockCompleteReviewMessageProcessing).toHaveBeenCalled()
  })

  test('processes question with LLM reply when review run has sourceBranch', async () => {
    const discussion = makeDiscussion({
      messages: [makeBotNote(), makeHumanNote({ body: 'Why did you flag this?' })],
    })
    setupMendOwnedThread(discussion)
    mockGetLatestSuccessfulReviewRun.mockImplementation(() =>
      Promise.resolve({
        id: 'run-1',
        projectKey: 'test-project',
        mrIid: 42,
        commitSha: 'abc123',
        model: 'test-model',
        source: 'webhook',
        status: 'success',
        workflowRunId: 'wf-1',
        webhookPayload: null,
        input: {
          sourceBranch: 'feature/test',
          targetBranch: 'main',
          projectKey: 'test-project',
          mrIid: 42,
          title: 'Test',
          description: '',
          labels: [],
          url: '',
        },
        result: null,
        comparisonResult: null,
        durationMs: 1000,
        error: null,
        completedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    )

    const payload = makeNotePayload({ note: 'Why did you flag this?' })

    await processGitlabMergeRequestNote({ project: makeProject(), payload })

    expect(mockGenerateThreadReply).toHaveBeenCalledTimes(1)
    const replyParams = (mockGenerateThreadReply.mock.calls[0] as unknown[])[0] as Record<
      string,
      unknown
    >
    expect(replyParams.requestId).toBe('note-999')
    expect(replyParams.sourceBranch).toBe('feature/test')
    expect(replyParams.commitSha).toBe('abc123')
    expect(replyParams.filePath).toBe('src/app.ts')
    expect(replyParams.userQuestion).toBe('Why did you flag this?')

    expect(mockReplyToThread).toHaveBeenCalledTimes(1)
    const replyCall = mockReplyToThread.mock.calls[0] as unknown[]
    const replyBody = replyCall[2] as string
    expect(replyBody).toBe('LLM-generated reply about the code.')

    expect(mockAddThreadMessageReaction).toHaveBeenCalledWith(42, 999, 'white_check_mark')
  })

  test('uses discussion first note as original finding when no local outbound message exists', async () => {
    const discussion = makeDiscussion({
      messages: [
        makeBotNote({ body: 'Original review comment from discussion' }),
        makeHumanNote({ body: 'Why did you flag this?' }),
      ],
    })
    const thread = makeThread()
    mockGetReviewThreadByProviderThreadId.mockImplementation(() => Promise.resolve(thread))
    mockListReviewMessagesForThread.mockImplementation(() => Promise.resolve([]))
    mockGetThread.mockImplementation(() => Promise.resolve(discussion))
    mockGetLatestSuccessfulReviewRun.mockImplementation(() =>
      Promise.resolve({
        id: 'run-1',
        projectKey: 'test-project',
        mrIid: 42,
        commitSha: 'abc123',
        model: 'test-model',
        source: 'webhook',
        status: 'success',
        workflowRunId: 'wf-1',
        webhookPayload: null,
        input: {
          sourceBranch: 'feature/test',
          targetBranch: 'main',
          projectKey: 'test-project',
          mrIid: 42,
          title: 'Test',
          description: '',
          labels: [],
          url: '',
        },
        result: null,
        comparisonResult: null,
        durationMs: 1000,
        error: null,
        completedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    )

    const payload = makeNotePayload({ note: 'Why did you flag this?' })

    await processGitlabMergeRequestNote({ project: makeProject(), payload })

    expect(mockGetThread).toHaveBeenCalledTimes(1)
    const replyParams = (mockGenerateThreadReply.mock.calls[0] as unknown[])[0] as Record<
      string,
      unknown
    >
    expect(replyParams.originalFinding).toBe('Original review comment from discussion')
  })

  test('falls back to error message when LLM reply fails', async () => {
    const discussion = makeDiscussion({
      messages: [makeBotNote(), makeHumanNote({ body: 'Why did you flag this?' })],
    })
    setupMendOwnedThread(discussion)
    mockGetLatestSuccessfulReviewRun.mockImplementation(() =>
      Promise.resolve({
        id: 'run-1',
        projectKey: 'test-project',
        mrIid: 42,
        commitSha: 'abc123',
        model: 'test-model',
        source: 'webhook',
        status: 'success',
        workflowRunId: 'wf-1',
        webhookPayload: null,
        input: {
          sourceBranch: 'feature/test',
          targetBranch: 'main',
          projectKey: 'test-project',
          mrIid: 42,
          title: 'Test',
          description: '',
          labels: [],
          url: '',
        },
        result: null,
        comparisonResult: null,
        durationMs: 1000,
        error: null,
        completedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    )
    mockGenerateThreadReply.mockImplementation(() => Promise.reject(new Error('LLM timeout')))

    const payload = makeNotePayload({ note: 'Why did you flag this?' })

    await processGitlabMergeRequestNote({ project: makeProject(), payload })

    expect(mockReplyToThread).toHaveBeenCalledTimes(1)
    const replyCall = mockReplyToThread.mock.calls[0] as unknown[]
    const replyBody = replyCall[2] as string
    expect(replyBody).toContain("wasn't able to generate a detailed response")
  })

  test('prefers the thread review run over the latest successful run for LLM context', async () => {
    const discussion = makeDiscussion({
      messages: [makeBotNote(), makeHumanNote({ body: 'Why did you flag this?' })],
    })
    const thread = makeThread({ reviewRunId: 'thread-run-1' })
    mockGetReviewThreadByProviderThreadId.mockImplementation(() => Promise.resolve(thread))
    mockListReviewMessagesForThread.mockImplementation(() => Promise.resolve([makeAgentMessage()]))
    mockGetThread.mockImplementation(() => Promise.resolve(discussion))

    mockGetLatestSuccessfulReviewRun.mockImplementation(() =>
      Promise.resolve({
        id: 'latest-run',
        projectKey: 'test-project',
        mrIid: 42,
        commitSha: 'latest123',
        model: 'test-model',
        source: 'webhook',
        status: 'success',
        workflowRunId: 'wf-latest',
        webhookPayload: null,
        input: {
          sourceBranch: 'feature/latest',
          targetBranch: 'main',
          projectKey: 'test-project',
          mrIid: 42,
          title: 'Test',
          description: '',
          labels: [],
          url: '',
        },
        result: null,
        comparisonResult: null,
        durationMs: 1000,
        error: null,
        completedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    )
    mockGetReviewRun.mockImplementation(() =>
      Promise.resolve({
        id: 'thread-run-1',
        projectKey: 'test-project',
        mrIid: 42,
        commitSha: 'thread123',
        model: 'test-model',
        source: 'webhook',
        status: 'success',
        workflowRunId: 'wf-thread',
        webhookPayload: null,
        input: {
          sourceBranch: 'feature/original',
          targetBranch: 'main',
          projectKey: 'test-project',
          mrIid: 42,
          title: 'Test',
          description: '',
          labels: [],
          url: '',
        },
        result: null,
        comparisonResult: null,
        durationMs: 1000,
        error: null,
        completedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    )

    const payload = makeNotePayload({ note: 'Why did you flag this?' })

    await processGitlabMergeRequestNote({ project: makeProject(), payload })

    const replyParams = (mockGenerateThreadReply.mock.calls[0] as unknown[])[0] as Record<
      string,
      unknown
    >
    expect(replyParams.sourceBranch).toBe('feature/original')
    expect(replyParams.commitSha).toBe('thread123')
  })

  test('uses graceful fallback when a known thread review run cannot be loaded', async () => {
    const discussion = makeDiscussion({
      messages: [makeBotNote(), makeHumanNote({ body: 'Why did you flag this?' })],
    })
    const thread = makeThread({ reviewRunId: 'missing-run' })
    mockGetReviewThreadByProviderThreadId.mockImplementation(() => Promise.resolve(thread))
    mockListReviewMessagesForThread.mockImplementation(() => Promise.resolve([makeAgentMessage()]))
    mockGetThread.mockImplementation(() => Promise.resolve(discussion))
    mockGetLatestSuccessfulReviewRun.mockImplementation(() =>
      Promise.resolve({
        id: 'latest-run',
        projectKey: 'test-project',
        mrIid: 42,
        commitSha: 'latest123',
        model: 'test-model',
        source: 'webhook',
        status: 'success',
        workflowRunId: 'wf-latest',
        webhookPayload: null,
        input: {
          sourceBranch: 'feature/latest',
          targetBranch: 'main',
          projectKey: 'test-project',
          mrIid: 42,
          title: 'Test',
          description: '',
          labels: [],
          url: '',
        },
        result: null,
        comparisonResult: null,
        durationMs: 1000,
        error: null,
        completedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    )
    mockGetReviewRun.mockImplementation(() => Promise.resolve(null))

    const payload = makeNotePayload({ note: 'Why did you flag this?' })

    await processGitlabMergeRequestNote({ project: makeProject(), payload })

    expect(mockGenerateThreadReply).not.toHaveBeenCalled()
    expect(mockReplyToThread).toHaveBeenCalledTimes(1)
    const replyCall = mockReplyToThread.mock.calls[0] as unknown[]
    const replyBody = replyCall[2] as string
    expect(replyBody).toContain('could not load the exact reviewed code context')
  })

  test('recovers missing thread reviewRunId from discussion markers for existing local thread', async () => {
    const discussion = makeDiscussion({
      messages: [
        makeBotNote({
          body: appendInlineMarkers(
            'Original review comment from bot',
            'thread-run-1',
            'src/app.ts',
            42,
          ),
        }),
        makeHumanNote({ body: 'Why did you flag this?' }),
      ],
    })
    const thread = makeThread({ reviewRunId: null })
    mockGetReviewThreadByProviderThreadId.mockImplementation(() => Promise.resolve(thread))
    mockListReviewMessagesForThread.mockImplementation(() => Promise.resolve([makeAgentMessage()]))
    mockGetThread.mockImplementation(() => Promise.resolve(discussion))
    mockUpsertReviewThread.mockImplementation(() =>
      Promise.resolve(makeThread({ reviewRunId: 'thread-run-1' })),
    )
    mockGetLatestSuccessfulReviewRun.mockImplementation(() =>
      Promise.resolve({
        id: 'latest-run',
        projectKey: 'test-project',
        mrIid: 42,
        commitSha: 'latest123',
        model: 'test-model',
        source: 'webhook',
        status: 'success',
        workflowRunId: 'wf-latest',
        webhookPayload: null,
        input: {
          sourceBranch: 'feature/latest',
          targetBranch: 'main',
          projectKey: 'test-project',
          mrIid: 42,
          title: 'Test',
          description: '',
          labels: [],
          url: '',
        },
        result: null,
        comparisonResult: null,
        durationMs: 1000,
        error: null,
        completedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    )
    mockGetReviewRun.mockImplementation(() =>
      Promise.resolve({
        id: 'thread-run-1',
        projectKey: 'test-project',
        mrIid: 42,
        commitSha: 'thread123',
        model: 'test-model',
        source: 'webhook',
        status: 'success',
        workflowRunId: 'wf-thread',
        webhookPayload: null,
        input: {
          sourceBranch: 'feature/original',
          targetBranch: 'main',
          projectKey: 'test-project',
          mrIid: 42,
          title: 'Test',
          description: '',
          labels: [],
          url: '',
        },
        result: null,
        comparisonResult: null,
        durationMs: 1000,
        error: null,
        completedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    )

    const payload = makeNotePayload({ note: 'Why did you flag this?' })

    await processGitlabMergeRequestNote({ project: makeProject(), payload })

    expect(mockGetThread).toHaveBeenCalledTimes(1)
    expect(mockGetReviewRun).toHaveBeenCalledWith('thread-run-1')
    const replyParams = (mockGenerateThreadReply.mock.calls[0] as unknown[])[0] as Record<
      string,
      unknown
    >
    expect(replyParams.sourceBranch).toBe('feature/original')
    expect(replyParams.commitSha).toBe('thread123')
  })

  test('replies with graceful fallback when no review run with sourceBranch is available', async () => {
    const discussion = makeDiscussion({
      messages: [makeBotNote(), makeHumanNote({ body: 'Why did you flag this?' })],
    })
    setupMendOwnedThread(discussion)

    const payload = makeNotePayload({ note: 'Why did you flag this?' })

    await processGitlabMergeRequestNote({ project: makeProject(), payload })

    expect(mockGenerateThreadReply).not.toHaveBeenCalled()
    expect(mockReplyToThread).toHaveBeenCalledTimes(1)
    const replyCall = mockReplyToThread.mock.calls[0] as unknown[]
    const replyBody = replyCall[2] as string
    expect(replyBody).toContain('could not load the exact reviewed code context')

    const reactionNames = (mockAddThreadMessageReaction.mock.calls as unknown[][]).map(
      (call) => (call[1] as Record<string, unknown>).name,
    )
    expect(reactionNames).not.toContain('white_check_mark')
  })

  test('stores inbound messages under thread reviewRunId when available', async () => {
    const discussion = makeDiscussion({
      messages: [makeBotNote(), makeHumanNote({ body: 'Why did you flag this?' })],
    })
    const thread = makeThread({ reviewRunId: 'thread-run-1' })
    mockGetReviewThreadByProviderThreadId.mockImplementation(() => Promise.resolve(thread))
    mockListReviewMessagesForThread.mockImplementation(() => Promise.resolve([makeAgentMessage()]))
    mockGetThread.mockImplementation(() => Promise.resolve(discussion))

    const payload = makeNotePayload({ note: 'Why did you flag this?' })

    await processGitlabMergeRequestNote({ project: makeProject(), payload })

    const createCall = mockCreateReviewMessageIfAbsent.mock.calls[0] as unknown[]
    const createParams = createCall[0] as Record<string, unknown>
    expect(createParams.reviewRunId).toBe('thread-run-1')
  })

  test('processes testing project rule from trusted user — creates project memory, posts confirmation, resolves thread', async () => {
    const discussion = makeDiscussion({
      messages: [
        makeBotNote(),
        makeHumanNote({
          id: '999',
          body: "We don't use component tests in this project.",
          author: { id: 300, username: 'trusted-user', raw: {} },
        }),
      ],
    })
    setupMendOwnedThread(discussion)
    const payload = makeNotePayload({
      note: "We don't use component tests in this project.",
    })
    payload.user = { id: 300, username: 'trusted-user' }

    await processGitlabMergeRequestNote({ project: makeProject(), payload })

    expect(mockCreateReviewMemoryEntry).toHaveBeenCalledTimes(1)
    const memoryCall = mockCreateReviewMemoryEntry.mock.calls[0]![0] as Record<string, unknown>
    expect(memoryCall.scope).toBe('project')
    expect(memoryCall.matchCategory).toBe('testing')

    expect(mockReplyToThread).toHaveBeenCalledTimes(1)
    const replyCall = mockReplyToThread.mock.calls[0] as unknown[]
    const replyBody = replyCall[2] as string
    expect(replyBody).toContain('project guidance')

    expect(mockResolveThread).toHaveBeenCalledTimes(1)
    expect(mockUpdateReviewThreadStatusByProviderThreadId).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'resolved' }),
    )
  })

  test('falls back to MR memory for testing rule from untrusted user — mentions trusted users', async () => {
    const discussion = makeDiscussion({
      messages: [
        makeBotNote(),
        makeHumanNote({
          id: '999',
          body: "We don't use component tests in this project.",
        }),
      ],
    })
    setupMendOwnedThread(discussion)
    const payload = makeNotePayload({
      note: "We don't use component tests in this project.",
    })

    await processGitlabMergeRequestNote({ project: makeProject(), payload })

    expect(mockCreateReviewMemoryEntry).toHaveBeenCalledTimes(1)
    const memoryCall = mockCreateReviewMemoryEntry.mock.calls[0]![0] as Record<string, unknown>
    expect(memoryCall.scope).toBe('mr')
    expect(memoryCall.matchCategory).toBe('testing')

    expect(mockReplyToThread).toHaveBeenCalledTimes(1)
    const replyCall = mockReplyToThread.mock.calls[0] as unknown[]
    const replyBody = replyCall[2] as string
    expect(replyBody).toContain('trusted users')
  })

  test('handles deferred dismissal — creates MR memory with kind defer_to_later, no reply', async () => {
    const discussion = makeDiscussion({
      messages: [makeBotNote(), makeHumanNote({ body: "We'll handle this in the next MR." })],
    })
    setupMendOwnedThread(discussion)
    const payload = makeNotePayload({ note: "We'll handle this in the next MR." })

    await processGitlabMergeRequestNote({ project: makeProject(), payload })

    expect(mockCreateReviewMemoryEntry).toHaveBeenCalledTimes(1)
    const memoryCall = mockCreateReviewMemoryEntry.mock.calls[0]![0] as Record<string, unknown>
    expect(memoryCall.scope).toBe('mr')
    expect(memoryCall.kind).toBe('defer_to_later')

    expect(mockReplyToThread).not.toHaveBeenCalled()

    expect(mockAddThreadMessageReaction).toHaveBeenCalledWith(42, 999, 'white_check_mark')
  })

  test('handles duplicate note — conflict on insert and claim fails — returns without processing', async () => {
    const discussion = makeDiscussion()
    setupMendOwnedThread(discussion)

    mockCreateReviewMessageIfAbsent.mockImplementation(() => Promise.resolve(null))
    mockGetReviewMessageByProviderMessageId.mockImplementation(() =>
      Promise.resolve(makeMessage({ processingStatus: 'completed' })),
    )
    mockClaimPendingReviewMessage.mockImplementation(() => Promise.resolve(false))

    const payload = makeNotePayload()

    await processGitlabMergeRequestNote({ project: makeProject(), payload })

    expect(mockAddThreadMessageReaction).not.toHaveBeenCalled()
    expect(mockReplyToThread).not.toHaveBeenCalled()
    expect(mockCreateReviewMemoryEntry).not.toHaveBeenCalled()
    expect(mockCompleteReviewMessageProcessing).not.toHaveBeenCalled()
  })

  test('resets message processing on error — resetReviewMessageProcessing called, error re-thrown', async () => {
    const discussion = makeDiscussion()
    setupMendOwnedThread(discussion)

    mockCreateReviewMemoryEntry.mockImplementation(() => {
      throw new Error('DB write failed')
    })

    const payload = makeNotePayload({ note: 'This is a false positive.' })

    await expect(
      processGitlabMergeRequestNote({ project: makeProject(), payload }),
    ).rejects.toThrow('DB write failed')

    expect(mockResetReviewMessageProcessing).toHaveBeenCalledTimes(1)
    expect(mockCompleteReviewMessageProcessing).not.toHaveBeenCalled()
  })

  test('resolves thread when plan says resolveThread — for MR-scoped dismissal', async () => {
    const discussion = makeDiscussion({
      messages: [makeBotNote(), makeHumanNote({ body: "Don't flag this again for this MR." })],
    })
    setupMendOwnedThread(discussion)
    const payload = makeNotePayload({ note: "Don't flag this again for this MR." })

    await processGitlabMergeRequestNote({ project: makeProject(), payload })

    expect(mockResolveThread).toHaveBeenCalledTimes(1)
    expect(mockUpdateReviewThreadStatusByProviderThreadId).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'gitlab',
        providerThreadId: 'discussion-abc',
        status: 'resolved',
      }),
    )

    expect(mockCreateReviewMemoryEntry).toHaveBeenCalledTimes(1)
    const memoryCall = mockCreateReviewMemoryEntry.mock.calls[0]![0] as Record<string, unknown>
    expect(memoryCall.scope).toBe('mr')
    expect(memoryCall.kind).toBe('ignore_this_mr')

    expect(mockAddThreadMessageReaction).toHaveBeenCalledWith(42, 999, 'white_check_mark')
  })

  test('does not mark a conversation thread resolved when the provider cannot resolve it', async () => {
    const discussion = makeDiscussion({
      messages: [makeBotNote(), makeHumanNote({ body: "Don't flag this again for this MR." })],
    })
    setupMendOwnedThread(discussion)
    mockResolveThread.mockImplementation(() => Promise.resolve(false))
    const payload = makeNotePayload({ note: "Don't flag this again for this MR." })

    await processGitlabMergeRequestNote({ project: makeProject(), payload })

    expect(mockResolveThread).toHaveBeenCalledWith(42, 'discussion-abc')
    expect(mockUpdateReviewThreadStatusByProviderThreadId).not.toHaveBeenCalled()
  })

  test('resolves summary_finding thread when plan says resolveThread', async () => {
    const discussion = makeDiscussion({
      messages: [
        makeBotNote({
          position: null,
          body: appendSummaryFindingMarkers('Finding thread text.', 'run-789', {
            fingerprint: 'summary_finding:dup-layout',
            previousFindingId: 'dup-layout',
            path: 'src/app.ts',
            line: 21,
          }),
        }),
        makeHumanNote({ body: "Don't flag this again for this MR.", position: null }),
      ],
    })
    const thread = makeThread({
      threadKind: 'summary_finding',
      path: 'src/app.ts',
      line: 21,
      findingFingerprint: 'summary_finding:dup-layout',
    })
    mockGetReviewThreadByProviderThreadId.mockImplementation(() => Promise.resolve(thread))
    mockListReviewMessagesForThread.mockImplementation(() => Promise.resolve([makeAgentMessage()]))
    mockGetThread.mockImplementation(() => Promise.resolve(discussion))

    const payload = makeNotePayload({ note: "Don't flag this again for this MR." })

    await processGitlabMergeRequestNote({ project: makeProject(), payload })

    expect(mockResolveThread).toHaveBeenCalledTimes(1)
    expect(mockUpdateReviewThreadStatusByProviderThreadId).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'gitlab',
        providerThreadId: 'discussion-abc',
        status: 'resolved',
      }),
    )
  })
})
