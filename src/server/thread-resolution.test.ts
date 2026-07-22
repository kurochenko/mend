import { describe, expect, it, mock } from 'bun:test'
import type { GitLabClient } from '@/integrations/gitlab/client'
import { executeThreadResolutions } from '@/server/thread-resolution'

const makeGitLab = (): GitLabClient => ({
  fetchCurrentUser: mock(async () => ({ id: 1, username: 'mend-bot' })),
  listMrNotes: mock(async () => []),
  listMrDraftNotes: mock(async () => []),
  createDraftNote: mock(async () => ({ id: 1 })),
  deleteDraftNote: mock(async () => {}),
  publishDraftNote: mock(async () => {}),
  bulkPublishDrafts: mock(async () => {}),
  createMrNote: mock(async () => ({ id: 1, body: '', author: null })),
  updateMrNote: mock(async () => ({ id: 1, body: '', author: null })),
  deleteMrNote: mock(async () => {}),
  listMrDiscussions: mock(async () => []),
  createDiscussion: mock(async () => ({
    id: 'discussion-1',
    individual_note: false,
    notes: [],
    raw: {},
  })),
  replyToDiscussion: mock(async (_mrIid: number, _discussionId: string, body: string) => ({
    id: 10,
    body,
    author: { id: 1, username: 'mend-bot', raw: {} },
    resolvable: false,
    raw: {},
  })),
  resolveDiscussion: mock(async () => {}),
})

describe('executeThreadResolutions', () => {
  it('replies, resolves fixed threads, and persists the outbound reply', async () => {
    const gitlab = makeGitLab()
    const persistReply = mock(async () => {})

    const stats = await executeThreadResolutions({
      gitlab,
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

    expect(gitlab.replyToDiscussion).toHaveBeenCalledWith(
      7,
      'discussion-1',
      'Verified as fixed in `abc`: done',
    )
    expect(gitlab.resolveDiscussion).toHaveBeenCalledWith(7, 'discussion-1')
    expect(persistReply).toHaveBeenCalledWith({
      discussionId: 'discussion-1',
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
