import { beforeEach, describe, expect, mock, test } from 'bun:test'

const mockGetReviewRun = mock<(...args: unknown[]) => Promise<unknown>>(() => Promise.resolve(null))
const mockListReviewThreadsForRun = mock<(...args: unknown[]) => Promise<unknown[]>>(() =>
  Promise.resolve([]),
)
const mockListReviewThreadsForMr = mock<(...args: unknown[]) => Promise<unknown[]>>(() =>
  Promise.resolve([]),
)
const mockListReviewFindingsForMr = mock<(...args: unknown[]) => Promise<unknown[]>>(() =>
  Promise.resolve([]),
)
const mockUpdateReviewThreadStatusByProviderThreadId = mock(() => Promise.resolve())
const mockGetReviewMessageByProviderMessageId = mock<(...args: unknown[]) => Promise<unknown>>(() =>
  Promise.resolve(null),
)
const mockUpsertReviewMessage = mock<(...args: unknown[]) => Promise<unknown>>(() =>
  Promise.resolve({ id: 'message-human-reply' }),
)
const mockCreateReviewMemoryEntry = mock<(...args: unknown[]) => Promise<unknown>>(() =>
  Promise.resolve({ id: 'memory-resolved-thread' }),
)
const mockArchiveActiveThreadResolvedMemoryForThread = mock(() => Promise.resolve())
const mockListThreads = mock<(...args: unknown[]) => Promise<unknown[]>>(() => Promise.resolve([]))

mock.module('@/db/review-runs', () => ({
  getReviewRun: mockGetReviewRun,
}))

mock.module('@/db/review-findings', () => ({
  listReviewFindingsForMr: mockListReviewFindingsForMr,
  upsertReviewFinding: mock(() => Promise.resolve(null)),
  getReviewFindingByProviderThreadId: mock(() => Promise.resolve(null)),
  getReviewFindingByThreadId: mock(() => Promise.resolve(null)),
  updateReviewFindingState: mock(() => Promise.resolve(null)),
  countReviewFindingsByStateForMr: mock(() => Promise.resolve({})),
  countReviewFindingSeveritiesForMr: mock(() =>
    Promise.resolve({ bug: 0, security: 0, performance: 0, suggestion: 0 }),
  ),
}))

mock.module('@/db/review-threads', () => ({
  listReviewThreadsForRun: mockListReviewThreadsForRun,
  listReviewThreadsForMr: mockListReviewThreadsForMr,
  getReviewThreadByProviderThreadId: mock(() => Promise.resolve(null)),
  getReviewMessageByProviderMessageId: mockGetReviewMessageByProviderMessageId,
  updateReviewThreadStatusByProviderThreadId: mockUpdateReviewThreadStatusByProviderThreadId,
  upsertReviewMessage: mockUpsertReviewMessage,
  upsertReviewThread: mock(() => Promise.resolve(null)),
}))

mock.module('@/db/review-memory', () => ({
  archiveActiveThreadResolvedMemoryForThread: mockArchiveActiveThreadResolvedMemoryForThread,
  createReviewMemoryEntry: mockCreateReviewMemoryEntry,
  THREAD_RESOLVED_MEMORY_KIND: 'thread_resolved',
}))

mock.module('@/integrations/provider/client', () => ({
  createReviewProvider: mock(() => ({
    kind: 'gitlab',
    fetchCurrentUser: mock(async () => ({ id: 1, username: 'mend-bot' })),
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
    getThread: mock(async () => ({ id: 'thread-1', isThread: true, messages: [], raw: {} })),
    createThread: mock(async () => ({ id: 'thread-1', isThread: true, messages: [], raw: {} })),
    replyToThread: mock(async () => ({
      id: '1',
      body: '',
      author: { id: 1, username: 'mend-bot', raw: {} },
      resolvable: false,
      position: null,
      raw: {},
    })),
    resolveThread: mock(async () => true),
    addNoteReaction: mock(async () => {}),
    addThreadMessageReaction: mock(async () => {}),
    publishReviewBatch: mock(async () => ({
      preExistingDraftCount: 0,
      recoveredDraftCount: 0,
      draftRecoveryAction: 'none' as const,
      summaryNoteId: 1,
      summaryReconciled: false,
    })),
  })),
}))

const { buildPreviousReviewContext, loadPublishedReviewThreadsForMr } = await import(
  '@/mastra/review/previous-context'
)

const makeThread = (params: {
  id: string
  fingerprint: string
  resolved: boolean
  humanReply?: { id: number; username: string; body: string; system?: boolean }
}) => ({
  id: params.id,
  isThread: true,
  raw: {},
  messages: [
    {
      id: '100',
      body: `Original finding\n\n<!-- mend:summary-finding ${JSON.stringify({
        fingerprint: params.fingerprint,
        previousFindingId: params.fingerprint,
      })} -->`,
      author: { id: 1, username: 'mend', raw: {} },
      resolvable: true,
      resolved: params.resolved,
      system: false,
      position: null,
      raw: {},
    },
    ...(params.humanReply
      ? [
          {
            id: `${params.humanReply.id}`,
            body: params.humanReply.body,
            author: { id: 2, username: params.humanReply.username, raw: {} },
            resolvable: false,
            system: params.humanReply.system ?? false,
            position: null,
            raw: {},
          },
        ]
      : []),
  ],
})

const makePostResult = (overrides: Record<string, unknown> = {}) => ({
  version: 'v2',
  projectKey: 'demo-frontend',
  mrIid: 1570,
  reviewRunId: 'run-1570',
  url: 'https://example.com/mr/1570',
  commitSha: 'abc123',
  reviewMode: 'initial',
  previousReviewedSha: null,
  previousRunId: null,
  reviewIntent: 'feature',
  reviewIntentConfidence: 0.9,
  reviewIntentRationale: ['feature term in title'],
  reviewTemplateId: 'feature',
  reviewTemplateSource: 'classifier',
  assessment: 'needs_discussion',
  summary: 'summary',
  findings: [],
  inlineComments: [],
  resolutionVerdicts: [],
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
    reviewMode: 'initial',
    previousReviewedSha: null,
    diffBaseRef: 'main',
    changedFileCount: 1,
    diffExcerptChars: 100,
    diffTruncated: false,
    intentClassifierModel: 'test-model',
    intentClassifierDurationMs: 1,
    intentClassifierFailure: null,
    intentSecondaryIntents: [],
    agent: {
      harness: 'pi',
      model: 'test-model',
      durationMs: 2,
    },
    inspection: {
      files: ['src/in-scope.ts'],
      changedFiles: ['src/in-scope.ts'],
      changedFileCount: 1,
      changedFileCoverage: 1,
    },
    contextPackageDiagnostics: [],
    templateWarnings: [],
  },
  comparisonResult: null,
  postedInlineComments: [],
  postedFindings: [],
  threadedFindings: [],
  threadedInlineComments: [],
  postDiagnostics: {
    findingsCount: 0,
    outOfScopeFindingCount: 0,
    inlineCommentCount: 0,
    outOfScopeInlineCount: 0,
    postedInlineCount: 0,
    preExistingDraftCount: 0,
    recoveredDraftCount: 0,
    draftRecoveryAction: 'none',
    skippedInlineReasons: {},
    resolvedThreadCount: 0,
    partiallyFixedThreadCount: 0,
    unmatchedVerdictCount: 0,
  },
  posted: 0,
  skipped: 0,
  reviewNumber: 1,
  summaryNoteId: 1,
  ...overrides,
})

describe('buildPreviousReviewContext', () => {
  beforeEach(() => {
    mockGetReviewRun.mockReset()
    mockListReviewThreadsForRun.mockReset()
    mockListReviewThreadsForMr.mockReset()
    mockListReviewFindingsForMr.mockReset()
    mockUpdateReviewThreadStatusByProviderThreadId.mockReset()
    mockGetReviewMessageByProviderMessageId.mockReset()
    mockUpsertReviewMessage.mockReset()
    mockCreateReviewMemoryEntry.mockReset()
    mockArchiveActiveThreadResolvedMemoryForThread.mockReset()
    mockListThreads.mockReset()

    mockListReviewThreadsForRun.mockImplementation(() => Promise.resolve([]))
    mockListReviewThreadsForMr.mockImplementation(() => Promise.resolve([]))
    mockListReviewFindingsForMr.mockImplementation(() => Promise.resolve([]))
    mockUpdateReviewThreadStatusByProviderThreadId.mockImplementation(() => Promise.resolve())
    mockGetReviewMessageByProviderMessageId.mockImplementation(() => Promise.resolve(null))
    mockUpsertReviewMessage.mockImplementation(() => Promise.resolve({ id: 'message-human-reply' }))
    mockCreateReviewMemoryEntry.mockImplementation(() =>
      Promise.resolve({ id: 'memory-resolved-thread' }),
    )
    mockArchiveActiveThreadResolvedMemoryForThread.mockImplementation(() => Promise.resolve())
    mockListThreads.mockImplementation(() => Promise.resolve([]))
  })

  test('merges threaded out-of-scope findings and inline comments into previous context', async () => {
    mockGetReviewRun.mockImplementation(() =>
      Promise.resolve({
        commitSha: 'abc123',
        result: {
          version: 'v2',
          projectKey: 'demo-frontend',
          mrIid: 1570,
          reviewRunId: 'run-1570',
          url: 'https://example.com/mr/1570',
          commitSha: 'abc123',
          reviewMode: 'initial',
          previousReviewedSha: null,
          previousRunId: null,
          reviewIntent: 'feature',
          reviewIntentConfidence: 0.9,
          reviewIntentRationale: ['feature term in title'],
          reviewTemplateId: 'feature',
          reviewTemplateSource: 'classifier',
          assessment: 'needs_discussion',
          summary: 'summary',
          findings: [
            {
              id: 'inline-backed',
              category: 'correctness',
              severity: 'bug',
              actionability: 'recommended',
              scope: 'single_file',
              title: 'Inline backed finding',
              body: 'This one already has an inline anchor.',
              evidence: [
                {
                  type: 'file_line',
                  file: 'src/in-scope.ts',
                  line: 10,
                  note: 'Inline-backed finding evidence.',
                },
              ],
              files: ['src/in-scope.ts'],
            },
          ],
          inlineComments: [
            {
              file: 'src/in-scope.ts',
              line: 10,
              severity: 'bug',
              body: 'Inline issue',
            },
          ],
          resolutionVerdicts: [],
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
            reviewMode: 'initial',
            previousReviewedSha: null,
            diffBaseRef: 'main',
            changedFileCount: 2,
            diffExcerptChars: 100,
            diffTruncated: false,
            intentClassifierModel: 'test-model',
            intentClassifierDurationMs: 1,
            intentClassifierFailure: null,
            intentSecondaryIntents: [],
            agent: {
              harness: 'pi',
              model: 'test-model',
              durationMs: 2,
            },
            inspection: {
              files: ['src/in-scope.ts'],
              changedFiles: ['src/in-scope.ts'],
              changedFileCount: 1,
              changedFileCoverage: 1,
            },
            contextPackageDiagnostics: [],
            templateWarnings: [],
          },
          comparisonResult: null,
          postedInlineComments: [
            {
              providerThreadId: null,
              providerMessageId: null,
            },
          ],
          postedFindings: [
            {
              providerThreadId: null,
              providerMessageId: null,
            },
          ],
          threadedFindings: [
            {
              id: 'cross-file-out-of-scope',
              category: 'correctness',
              severity: 'bug',
              actionability: 'recommended',
              scope: 'cross_file',
              title: 'Out-of-scope finding',
              body: 'This was posted as its own discussion.',
              evidence: [
                {
                  type: 'file_line',
                  file: 'src/out-of-scope.ts',
                  line: 21,
                  note: 'Out-of-scope finding evidence.',
                },
              ],
              files: ['src/out-of-scope.ts'],
              providerThreadId: 'discussion-finding',
              providerMessageId: 'note-finding',
            },
          ],
          threadedInlineComments: [
            {
              file: 'src/out-of-scope.ts',
              line: 21,
              severity: 'suggestion',
              body: 'Skipped inline issue',
              providerThreadId: 'discussion-inline',
              providerMessageId: 'note-inline',
            },
          ],
          postDiagnostics: {
            findingsCount: 1,
            outOfScopeFindingCount: 1,
            inlineCommentCount: 1,
            outOfScopeInlineCount: 1,
            postedInlineCount: 0,
            preExistingDraftCount: 0,
            recoveredDraftCount: 0,
            draftRecoveryAction: 'none',
            skippedInlineReasons: {
              out_of_scope_file: 1,
            },
            resolvedThreadCount: 0,
            partiallyFixedThreadCount: 0,
            unmatchedVerdictCount: 0,
          },
          posted: 0,
          skipped: 1,
          reviewNumber: 1,
          summaryNoteId: 1,
        },
      }),
    )
    mockListReviewThreadsForMr.mockImplementation(() =>
      Promise.resolve([
        {
          provider: 'gitlab',
          providerThreadId: 'discussion-finding',
          threadKind: 'summary_finding',
          status: 'open',
        },
        {
          provider: 'gitlab',
          providerThreadId: 'discussion-inline',
          threadKind: 'summary_finding',
          status: 'resolved',
        },
      ]),
    )

    const context = await buildPreviousReviewContext({
      project: { platform: 'gitlab', project_id: 1 } as never,
      mrIid: 1570,
      previousRunId: 'run-1570',
    })

    expect(context).not.toBeNull()
    expect(context?.findings.map((finding) => finding.id)).toEqual([
      'inline-backed',
      'cross-file-out-of-scope',
    ])
    expect(context?.findings[1]).toMatchObject({
      discussionId: 'discussion-finding',
      resolved: false,
    })
    expect(context?.inlineComments).toContainEqual(
      expect.objectContaining({
        file: 'src/out-of-scope.ts',
        line: 21,
        discussionId: 'discussion-inline',
        resolved: true,
      }),
    )
  })

  test('reconstructs typed blocker history across updates without collapsing same-line threads', async () => {
    mockGetReviewRun.mockImplementation(() =>
      Promise.resolve({
        commitSha: 'latest-sha',
        result: makePostResult({ reviewMode: 'update' }),
      }),
    )
    mockListReviewFindingsForMr.mockImplementation(() =>
      Promise.resolve([
        {
          providerThreadId: 'finding-old',
          metadata: {
            kind: 'finding',
            finding: {
              id: 'old-required',
              category: 'correctness',
              severity: 'bug',
              actionability: 'required',
              scope: 'cross_file',
              title: 'Old required blocker',
              body: 'Still tracked from an earlier update.',
              files: ['src/old.ts'],
              evidence: [{ type: 'file_line', file: 'src/old.ts', line: 3 }],
            },
          },
        },
        {
          providerThreadId: 'finding-optional',
          metadata: {
            kind: 'finding',
            finding: {
              id: 'old-optional',
              category: 'performance',
              severity: 'performance',
              actionability: 'optional',
              scope: 'single_file',
              title: 'Optional history',
              body: 'This must never gate.',
              files: ['src/old.ts'],
              evidence: [{ type: 'file_line', file: 'src/old.ts', line: 4 }],
            },
          },
        },
        ...['inline-a', 'inline-b'].map((providerThreadId) => ({
          providerThreadId,
          metadata: {
            kind: 'inline_comment',
            inlineComment: {
              file: 'src/same-line.ts',
              line: 9,
              severity: 'bug',
              body: `Distinct blocker ${providerThreadId}`,
            },
          },
        })),
        {
          providerThreadId: 'finding-resolved',
          metadata: {
            kind: 'finding',
            finding: {
              id: 'resolved-required',
              category: 'security',
              severity: 'security',
              actionability: 'required',
              scope: 'single_file',
              title: 'Resolved history',
              body: 'This no longer gates.',
              files: ['src/resolved.ts'],
              evidence: [{ type: 'file_line', file: 'src/resolved.ts', line: 5 }],
            },
          },
        },
        {
          providerThreadId: 'finding-reopened',
          metadata: {
            kind: 'finding',
            finding: {
              id: 'reopened-required',
              category: 'correctness',
              severity: 'bug',
              actionability: 'required',
              scope: 'single_file',
              title: 'Reopened history',
              body: 'This gates again.',
              files: ['src/reopened.ts'],
              evidence: [{ type: 'file_line', file: 'src/reopened.ts', line: 6 }],
            },
          },
        },
      ]),
    )
    mockListReviewThreadsForMr.mockImplementation(() =>
      Promise.resolve(
        [
          'finding-old',
          'finding-optional',
          'inline-a',
          'inline-b',
          'finding-resolved',
          'finding-reopened',
        ].map((providerThreadId) => ({
          provider: 'gitlab',
          providerThreadId,
          threadKind: providerThreadId.startsWith('inline') ? 'inline' : 'summary_finding',
          status:
            providerThreadId === 'finding-resolved' || providerThreadId === 'finding-reopened'
              ? 'resolved'
              : 'open',
        })),
      ),
    )
    mockListThreads.mockImplementation(() =>
      Promise.resolve([
        {
          id: 'finding-reopened',
          isThread: true,
          messages: [
            {
              id: 'reopened-note',
              body: 'Reopened thread',
              author: { id: 1, username: 'mend-bot', raw: {} },
              resolvable: true,
              resolved: false,
              position: null,
              raw: {},
            },
          ],
          raw: {},
        },
      ]),
    )

    const context = await buildPreviousReviewContext({
      project: { key: 'demo', platform: 'gitlab', project_id: 1 } as never,
      mrIid: 1570,
      previousRunId: 'run-latest',
    })

    expect(context?.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          identity: 'finding:finding-old',
          actionability: 'required',
          resolved: false,
        }),
        expect.objectContaining({
          identity: 'finding:finding-optional',
          actionability: 'optional',
          resolved: false,
        }),
        expect.objectContaining({ identity: 'finding:finding-resolved', resolved: true }),
        expect.objectContaining({ identity: 'finding:finding-reopened', resolved: false }),
      ]),
    )
    expect(context?.inlineComments.map((comment) => comment.identity)).toEqual([
      'inline:inline-a',
      'inline:inline-b',
    ])
  })

  test('keeps distinct current-run threads even when legacy content identifiers collide', async () => {
    const duplicateFinding = {
      id: 'duplicate-model-id',
      category: 'correctness',
      severity: 'bug',
      actionability: 'required',
      scope: 'single_file',
      title: 'Duplicate model id',
      body: 'Distinct provider threads remain distinct.',
      files: ['src/app.ts'],
      evidence: [{ type: 'file_line', file: 'src/app.ts', line: 7 }],
    }
    const duplicateInline = {
      file: 'src/app.ts',
      line: 7,
      severity: 'bug',
      body: 'Identical location and body.',
    }
    mockGetReviewRun.mockImplementation(() =>
      Promise.resolve({
        commitSha: 'latest-sha',
        result: makePostResult({
          findings: [duplicateFinding],
          postedFindings: [
            { providerThreadId: 'finding-thread-a', providerMessageId: 'finding-message-a' },
          ],
          threadedFindings: [
            {
              ...duplicateFinding,
              providerThreadId: 'finding-thread-b',
              providerMessageId: 'finding-message-b',
            },
          ],
          inlineComments: [duplicateInline],
          postedInlineComments: [
            { providerThreadId: 'inline-thread-a', providerMessageId: 'inline-message-a' },
          ],
          threadedInlineComments: [
            {
              ...duplicateInline,
              providerThreadId: 'inline-thread-b',
              providerMessageId: 'inline-message-b',
            },
          ],
        }),
      }),
    )

    const context = await buildPreviousReviewContext({
      project: { key: 'demo', platform: 'gitlab', project_id: 1 } as never,
      mrIid: 1570,
      previousRunId: 'run-latest',
    })

    expect(context?.findings.map((finding) => finding.identity)).toEqual([
      'finding:finding-thread-a',
      'finding:finding-thread-b',
    ])
    expect(context?.inlineComments.map((comment) => comment.identity)).toEqual([
      'inline:inline-thread-a',
      'inline:inline-thread-b',
    ])
  })

  test('loads open and resolved stored threads while live status wins and archived stays excluded', async () => {
    mockListReviewThreadsForMr.mockImplementation(() =>
      Promise.resolve([
        {
          id: 'thread-live',
          providerThreadId: 'discussion-live',
          threadKind: 'summary_finding',
          findingFingerprint: 'finding-live',
          status: 'open',
          reviewRunId: 'run-1',
          path: 'src/live.ts',
          line: 4,
        },
        {
          id: 'thread-resolved',
          providerThreadId: 'discussion-resolved',
          threadKind: 'summary_finding',
          findingFingerprint: 'finding-resolved',
          status: 'resolved',
          reviewRunId: 'run-1',
          path: 'src/resolved.ts',
          line: 8,
        },
        {
          id: 'thread-archived',
          providerThreadId: 'discussion-archived',
          threadKind: 'summary_finding',
          findingFingerprint: 'finding-archived',
          status: 'archived',
          reviewRunId: 'run-1',
          path: 'src/archived.ts',
          line: 12,
        },
      ]),
    )
    mockListThreads.mockImplementation(() =>
      Promise.resolve([
        makeThread({
          id: 'discussion-live',
          fingerprint: 'finding-live',
          resolved: true,
        }),
        makeThread({
          id: 'discussion-archived',
          fingerprint: 'finding-archived',
          resolved: false,
        }),
      ]),
    )

    const threads = await loadPublishedReviewThreadsForMr({
      project: { platform: 'gitlab', project_id: 1 } as never,
      projectKey: 'demo',
      mrIid: 12,
    })

    expect(threads).toEqual([
      { findingFingerprint: 'finding-live', status: 'resolved' },
      { findingFingerprint: 'finding-resolved', status: 'resolved' },
    ])
    expect(mockUpdateReviewThreadStatusByProviderThreadId).toHaveBeenCalledTimes(1)
  })

  test('creates MR memory from the latest human reply on a resolved Mend thread', async () => {
    mockListReviewThreadsForMr.mockImplementation(() =>
      Promise.resolve([
        {
          id: 'thread-1',
          providerThreadId: 'discussion-1',
          threadKind: 'summary_finding',
          findingFingerprint: 'finding-1',
          status: 'open',
          reviewRunId: 'run-1',
          path: 'src/app.ts',
          line: 7,
        },
      ]),
    )
    mockListThreads.mockImplementation(() =>
      Promise.resolve([
        makeThread({
          id: 'discussion-1',
          fingerprint: 'finding-1',
          resolved: true,
          humanReply: { id: 321, username: 'reviewer', body: 'This is intentional.' },
        }),
      ]),
    )

    await loadPublishedReviewThreadsForMr({
      project: { platform: 'gitlab', project_id: 1 } as never,
      projectKey: 'demo',
      mrIid: 12,
    })

    expect(mockUpsertReviewMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 'thread-1',
        providerMessageId: '321',
        authorType: 'human',
        authorName: 'reviewer',
        body: 'This is intentional.',
      }),
    )
    expect(mockCreateReviewMemoryEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: 'mr',
        projectKey: 'demo',
        mrIid: 12,
        threadId: 'thread-1',
        sourceMessageId: 'message-human-reply',
        kind: 'thread_resolved',
        matchFingerprint: 'finding-1',
        matchPath: 'src/app.ts',
        matchLine: 7,
        createdByName: 'reviewer',
        metadata: expect.objectContaining({
          humanReplyBody: 'This is intentional.',
          humanReplyNoteId: '321',
        }),
      }),
    )
  })

  test('does not create memory from a system reply', async () => {
    mockListReviewThreadsForMr.mockImplementation(() =>
      Promise.resolve([
        {
          id: 'thread-1',
          providerThreadId: 'discussion-1',
          threadKind: 'summary_finding',
          findingFingerprint: 'finding-1',
          status: 'open',
          reviewRunId: 'run-1',
          path: 'src/app.ts',
          line: 7,
        },
      ]),
    )
    mockListThreads.mockImplementation(() =>
      Promise.resolve([
        makeThread({
          id: 'discussion-1',
          fingerprint: 'finding-1',
          resolved: true,
          humanReply: {
            id: 321,
            username: 'gitlab-system',
            body: 'changed resolution',
            system: true,
          },
        }),
      ]),
    )

    const threads = await loadPublishedReviewThreadsForMr({
      project: { platform: 'gitlab', project_id: 1 } as never,
      projectKey: 'demo',
      mrIid: 12,
    })

    expect(threads).toEqual([{ findingFingerprint: 'finding-1', status: 'resolved' }])
    expect(mockUpsertReviewMessage).not.toHaveBeenCalled()
    expect(mockCreateReviewMemoryEntry).not.toHaveBeenCalled()
  })

  test('keeps reopened fingerprints when archiving resolved-thread memory fails', async () => {
    mockListReviewThreadsForMr.mockImplementation(() =>
      Promise.resolve([
        {
          id: 'thread-1',
          providerThreadId: 'discussion-1',
          threadKind: 'summary_finding',
          findingFingerprint: 'finding-1',
          status: 'resolved',
          reviewRunId: 'run-1',
          path: 'src/app.ts',
          line: 7,
        },
      ]),
    )
    mockListThreads.mockImplementation(() =>
      Promise.resolve([
        makeThread({
          id: 'discussion-1',
          fingerprint: 'finding-1',
          resolved: false,
        }),
      ]),
    )
    mockArchiveActiveThreadResolvedMemoryForThread.mockImplementation(() =>
      Promise.reject(new Error('db down')),
    )

    const threads = await loadPublishedReviewThreadsForMr({
      project: { platform: 'gitlab', project_id: 1 } as never,
      projectKey: 'demo',
      mrIid: 12,
    })

    expect(threads).toEqual([{ findingFingerprint: 'finding-1', status: 'open' }])
    expect(mockArchiveActiveThreadResolvedMemoryForThread).toHaveBeenCalledWith({
      projectKey: 'demo',
      threadId: 'thread-1',
    })
    expect(mockCreateReviewMemoryEntry).not.toHaveBeenCalled()
  })

  test('keeps resolved fingerprints when automatic memory creation fails', async () => {
    mockListReviewThreadsForMr.mockImplementation(() =>
      Promise.resolve([
        {
          id: 'thread-1',
          providerThreadId: 'discussion-1',
          threadKind: 'summary_finding',
          findingFingerprint: 'finding-1',
          status: 'open',
          reviewRunId: 'run-1',
          path: 'src/app.ts',
          line: 7,
        },
      ]),
    )
    mockListThreads.mockImplementation(() =>
      Promise.resolve([
        makeThread({
          id: 'discussion-1',
          fingerprint: 'finding-1',
          resolved: true,
          humanReply: { id: 321, username: 'reviewer', body: 'This is intentional.' },
        }),
      ]),
    )
    mockCreateReviewMemoryEntry.mockImplementation(() => Promise.reject(new Error('db down')))

    const threads = await loadPublishedReviewThreadsForMr({
      project: { platform: 'gitlab', project_id: 1 } as never,
      projectKey: 'demo',
      mrIid: 12,
    })

    expect(threads).toEqual([{ findingFingerprint: 'finding-1', status: 'resolved' }])
  })

  test('loads and refreshes stored github thread status for github projects', async () => {
    mockGetReviewRun.mockImplementation(() =>
      Promise.resolve({
        commitSha: 'abc123',
        result: makePostResult({
          threadedFindings: [
            {
              id: 'github-finding',
              category: 'correctness',
              severity: 'bug',
              actionability: 'recommended',
              scope: 'cross_file',
              title: 'GitHub finding',
              body: 'This was posted as a GitHub thread.',
              evidence: [
                {
                  type: 'file_line',
                  file: 'src/github.ts',
                  line: 21,
                  note: 'GitHub finding evidence.',
                },
              ],
              files: ['src/github.ts'],
              providerThreadId: 'github-thread',
              providerMessageId: 'github-note',
            },
            {
              id: 'stored-only-github-finding',
              category: 'correctness',
              severity: 'bug',
              actionability: 'recommended',
              scope: 'cross_file',
              title: 'Stored GitHub finding',
              body: 'This one only has stored status.',
              evidence: [
                {
                  type: 'file_line',
                  file: 'src/stored.ts',
                  line: 22,
                  note: 'Stored GitHub finding evidence.',
                },
              ],
              files: ['src/stored.ts'],
              providerThreadId: 'stored-github-thread',
              providerMessageId: 'stored-github-note',
            },
          ],
        }),
      }),
    )
    mockListReviewThreadsForMr.mockImplementation(() =>
      Promise.resolve([
        {
          provider: 'gitlab',
          providerThreadId: 'github-thread',
          threadKind: 'summary_finding',
          status: 'resolved',
        },
        {
          provider: 'github',
          providerThreadId: 'stored-github-thread',
          threadKind: 'summary_finding',
          status: 'resolved',
        },
      ]),
    )
    mockListThreads.mockImplementation(() =>
      Promise.resolve([
        {
          id: 'github-thread',
          isThread: true,
          messages: [
            {
              id: 'github-note',
              body: 'Thread body',
              author: { id: 1, username: 'mend-bot', raw: {} },
              resolvable: true,
              resolved: false,
              position: null,
              raw: {},
            },
          ],
          raw: {},
        },
      ]),
    )

    const context = await buildPreviousReviewContext({
      project: { platform: 'github', repo: 'org/repo' } as never,
      mrIid: 1570,
      previousRunId: 'run-1570',
    })

    expect(context?.findings).toContainEqual(
      expect.objectContaining({
        id: 'github-finding',
        discussionId: 'github-thread',
        resolved: false,
      }),
    )
    expect(context?.findings).toContainEqual(
      expect.objectContaining({
        id: 'stored-only-github-finding',
        discussionId: 'stored-github-thread',
        resolved: true,
      }),
    )
    expect(mockUpdateReviewThreadStatusByProviderThreadId).toHaveBeenCalledWith({
      provider: 'github',
      providerThreadId: 'github-thread',
      status: 'open',
    })
  })
})
