import { describe, expect, it, mock } from 'bun:test'
import type { ReviewFindingRecord } from '@/db/review-findings'
import type { ReviewThreadRecord } from '@/db/review-threads'
import { persistProviderReplyLocally } from '@/server/thread-sync'

describe('persistProviderReplyLocally', () => {
  it('reconstructs a missing finding before persisting its resolved state', async () => {
    const thread = {
      id: 'thread-row',
      provider: 'github',
      projectKey: 'github-project',
      repoExternalId: 'org/repo',
      reviewExternalId: 42,
      reviewRunId: 'original-run',
      threadKind: 'summary_finding',
      subjectType: 'general',
      path: null,
      line: null,
      findingFingerprint: 'summary_finding:legacy-blocker',
      status: 'open',
      providerThreadId: 'note_55',
      providerUrl: null,
      rawProviderData: null,
      providerCreatedAt: null,
      providerUpdatedAt: null,
      createdAt: new Date('2026-08-06T12:00:00Z'),
      updatedAt: new Date('2026-08-06T12:00:00Z'),
    } satisfies ReviewThreadRecord
    const reconstructedFinding = { id: 'reconstructed-finding' } as ReviewFindingRecord
    const upsertReviewFinding = mock(async () => reconstructedFinding)
    const updateReviewFindingState = mock(async () => reconstructedFinding)

    await persistProviderReplyLocally({
      provider: 'github',
      threadId: 'note_55',
      reviewRunId: 'fixed-run',
      reply: {
        id: '56',
        body: 'Verified as fixed in `fixed-sha`.',
        author: { id: 1, username: 'mend-bot', raw: {} },
        resolvable: false,
        position: null,
        raw: {},
      },
      markResolved: false,
      markFindingResolved: true,
      dependencies: {
        getReviewThreadByProviderThreadId: mock(async () => thread),
        upsertReviewMessage: mock(async () => null as never),
        getReviewFindingByProviderThreadId: mock(async () => null),
        upsertReviewFinding,
        updateReviewFindingState,
      },
    })

    expect(upsertReviewFinding).toHaveBeenCalledWith({
      projectKey: 'github-project',
      mrIid: 42,
      reviewRunId: 'original-run',
      threadId: 'thread-row',
      provider: 'github',
      providerThreadId: 'note_55',
    })
    expect(updateReviewFindingState).toHaveBeenCalledWith({
      id: 'reconstructed-finding',
      state: 'resolved',
      decisionReason: 'Verified as fixed in `fixed-sha`.',
      decidedByExternalId: '1',
      decidedByName: 'mend-bot',
    })
  })
})
