import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { closeDb, getDb, initDb } from '@/db/client'
import {
  countReviewFindingSeveritiesForMr,
  countReviewFindingsByStateForMr,
  getReviewFindingByProviderThreadId,
  getReviewFindingByThreadId,
  listReviewFindingsForMr,
  updateReviewFindingState,
  upsertReviewFinding,
} from '@/db/review-findings'
import { upsertReviewThread } from '@/db/review-threads'
import { reviewFindings, reviewThreads } from '@/db/schema'

const testDatabaseUrl = process.env.TEST_DATABASE_URL

const projectKey = 'review-findings-test'
const mrIid = 42

const deleteTestRows = async () => {
  const db = getDb()
  await db.delete(reviewFindings).where(eq(reviewFindings.projectKey, projectKey))
  await db.delete(reviewThreads).where(eq(reviewThreads.projectKey, projectKey))
}

const createThread = async (providerThreadId: string) =>
  await upsertReviewThread({
    provider: 'gitlab',
    projectKey,
    repoExternalId: '100',
    reviewExternalId: mrIid,
    reviewRunId: 'run-1',
    threadKind: 'inline',
    subjectType: 'line',
    path: 'src/app.ts',
    line: 10,
    status: 'open',
    providerThreadId,
  })

if (!testDatabaseUrl) {
  describe.skip('review finding persistence', () => {
    test('requires TEST_DATABASE_URL', () => {})
  })
} else {
  describe('review finding persistence', () => {
    beforeAll(async () => {
      await initDb(testDatabaseUrl)
    })

    afterAll(async () => {
      await closeDb()
    })

    beforeEach(async () => {
      await deleteTestRows()
    })

    test('creates and queries a finding by MR and provider thread', async () => {
      const thread = await createThread('discussion-1')
      const finding = await upsertReviewFinding({
        projectKey,
        mrIid,
        reviewRunId: 'run-1',
        threadId: thread.id,
        provider: 'gitlab',
        providerThreadId: 'discussion-1',
        providerNoteId: 'note-1',
        metadata: { category: 'bug' },
      })

      expect(finding.state).toBe('pending')
      expect(finding.providerNoteId).toBe('note-1')

      const byThread = await getReviewFindingByProviderThreadId({
        provider: 'gitlab',
        providerThreadId: 'discussion-1',
      })
      const forMr = await listReviewFindingsForMr({ projectKey, mrIid })
      const byThreadId = await getReviewFindingByThreadId(thread.id)

      expect(byThread?.id).toBe(finding.id)
      expect(byThreadId?.id).toBe(finding.id)
      expect(forMr.map((row) => row.id)).toEqual([finding.id])
    })

    test('updates state and exposes summary counts', async () => {
      const thread = await createThread('discussion-2')
      const finding = await upsertReviewFinding({
        projectKey,
        mrIid,
        threadId: thread.id,
        provider: 'gitlab',
        providerThreadId: 'discussion-2',
      })

      const updated = await updateReviewFindingState({
        id: finding.id,
        state: 'accepted',
        decisionReason: 'valid finding',
        decidedByExternalId: '7',
        decidedByName: 'Reviewer',
      })
      const counts = await countReviewFindingsByStateForMr({ projectKey, mrIid })

      expect(updated?.state).toBe('accepted')
      expect(updated?.decisionReason).toBe('valid finding')
      expect(updated?.decidedAt).toBeInstanceOf(Date)
      expect(counts).toEqual({ accepted: 1 })
    })

    test('counts valid severities from finding metadata for an MR', async () => {
      const metadataByThreadId = [
        { kind: 'finding', finding: { severity: 'bug' } },
        { kind: 'inline_comment', inlineComment: { severity: 'suggestion' } },
        { kind: 'finding', finding: { severity: 'invalid' } },
        { kind: 'unknown', finding: { severity: 'security' } },
      ]

      for (const [index, metadata] of metadataByThreadId.entries()) {
        const providerThreadId = `severity-discussion-${index}`
        const thread = await createThread(providerThreadId)
        await upsertReviewFinding({
          projectKey,
          mrIid,
          threadId: thread.id,
          provider: 'gitlab',
          providerThreadId,
          metadata,
        })
      }

      const counts = await countReviewFindingSeveritiesForMr({ projectKey, mrIid })

      expect(counts).toEqual({
        bug: 1,
        security: 0,
        performance: 0,
        suggestion: 1,
      })
    })

    test('upsert is idempotent and preserves human decision state', async () => {
      const thread = await createThread('discussion-3')
      const first = await upsertReviewFinding({
        projectKey,
        mrIid,
        reviewRunId: 'run-1',
        threadId: thread.id,
        provider: 'gitlab',
        providerThreadId: 'discussion-3',
        providerNoteId: 'note-1',
      })

      await updateReviewFindingState({
        id: first.id,
        state: 'rejected',
        decisionReason: 'not actionable',
      })

      const second = await upsertReviewFinding({
        projectKey,
        mrIid,
        reviewRunId: 'run-2',
        threadId: thread.id,
        provider: 'gitlab',
        providerThreadId: 'discussion-3',
        providerNoteId: 'note-2',
      })
      const forMr = await listReviewFindingsForMr({ projectKey, mrIid })

      expect(second.id).toBe(first.id)
      expect(second.state).toBe('rejected')
      expect(second.providerNoteId).toBe('note-2')
      expect(forMr).toHaveLength(1)
    })
  })
}
