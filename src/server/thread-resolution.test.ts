import { describe, expect, it, mock } from 'bun:test'
import type { ReviewProvider } from '@/integrations/provider/client'
import { executeThreadResolutions } from '@/server/thread-resolution'

const makeProvider = (): ReviewProvider => ({
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
  listThreads: mock(async () => []),
  getThread: mock(async () => ({
    id: 'discussion-1',
    isThread: true,
    messages: [],
    raw: {},
  })),
  createThread: mock(async () => ({ id: 'discussion-1', isThread: true, messages: [], raw: {} })),
  replyToThread: mock(async (_mrIid: number, _discussionId: string, body: string) => ({
    id: '10',
    body,
    author: { id: 1, username: 'mend-bot', raw: {} },
    resolvable: false,
    position: null,
    raw: {},
  })),
  resolveThread: mock(async () => {}),
  addNoteReaction: mock(async () => {}),
  addThreadMessageReaction: mock(async () => {}),
  publishReviewBatch: mock(async () => ({
    preExistingDraftCount: 0,
    recoveredDraftCount: 0,
    draftRecoveryAction: 'none' as const,
    summaryNoteId: 1,
    summaryReconciled: false,
  })),
})

describe('executeThreadResolutions', () => {
  it('replies, resolves fixed threads, and persists the outbound reply', async () => {
    const provider = makeProvider()
    const persistReply = mock(async () => {})

    const stats = await executeThreadResolutions({
      provider,
      mrIid: 7,
      reviewRunId: 'run-2',
      unmatchedVerdictCount: 1,
      resolutions: [
        {
          previousFindingId: 'finding-1',
          discussionId: 'discussion-1',
          status: 'fixed',
          replyBody: 'Verified as fixed in `abc`: done',
          markResolved: true,
        },
      ],
      dependencies: { persistReply },
    })

    expect(provider.replyToThread).toHaveBeenCalledWith(
      7,
      'discussion-1',
      'Verified as fixed in `abc`: done',
    )
    expect(provider.resolveThread).toHaveBeenCalledWith(7, 'discussion-1')
    expect(persistReply).toHaveBeenCalledWith({
      threadId: 'discussion-1',
      reviewRunId: 'run-2',
      reply: expect.objectContaining({ body: 'Verified as fixed in `abc`: done' }),
      markResolved: true,
    })
    expect(stats).toEqual({
      resolvedThreadCount: 1,
      partiallyFixedThreadCount: 0,
      unmatchedVerdictCount: 1,
    })
  })
})
