import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { closeDb, getDb, initDb } from '@/db/client'
import {
  completeFixBatchRun,
  failFixBatchRun,
  listRunnableFixBatches,
  recordFixBatchPush,
  recoverFixBatchesAfterRestart,
  startFixBatchRun,
  upsertPendingFixBatch,
} from '@/db/fix-batches'
import { mrFixBatches } from '@/db/schema'

const testDatabaseUrl = process.env.TEST_DATABASE_URL
const projectKey = 'fix-batches-test'
const mrIid = 42

const deleteTestRows = async () => {
  const db = getDb()
  await db.delete(mrFixBatches).where(eq(mrFixBatches.projectKey, projectKey))
}

describe('fix batch persistence', () => {
  if (!testDatabaseUrl) {
    test('requires TEST_DATABASE_URL', () => {
      expect(testDatabaseUrl).toBeUndefined()
    })
  } else {
    beforeAll(async () => {
      await initDb(testDatabaseUrl)
    })

    afterAll(async () => {
      await closeDb()
    })

    beforeEach(async () => {
      await deleteTestRows()
    })

    test('tracks pending, running, completed, and failed batch state', async () => {
      const queued = await upsertPendingFixBatch({
        projectKey,
        mrIid,
        force: false,
        requestNoteId: 'note-1',
        requestThreadId: 'thread-1',
        requestedByExternalId: 'user-1',
        requestedByName: 'Reviewer',
        acceptedFindingIds: ['finding-1'],
        pendingFindingIds: [],
      })

      expect(queued.status).toBe('pending')
      expect(queued.loopCount).toBe(0)

      const running = await startFixBatchRun({ projectKey, mrIid, maxLoops: 3 })

      expect(running.status).toBe('running')
      expect(running.loopCount).toBe(1)

      const completed = await completeFixBatchRun({
        projectKey,
        mrIid,
        sourceBranch: 'feature/fix',
        pushedCommitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        result: { ok: true },
      })

      expect(completed.status).toBe('completed')
      expect(completed.sourceBranch).toBe('feature/fix')
      expect(completed.pushedCommitSha).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
      expect(completed.result).toEqual({ ok: true })

      const next = await upsertPendingFixBatch({
        projectKey,
        mrIid,
        force: true,
        acceptedFindingIds: ['finding-2'],
        pendingFindingIds: [],
      })
      const failed = await failFixBatchRun({
        projectKey,
        mrIid,
        failureMessage: 'push failed',
        result: { ok: false },
        sourceBranch: 'feature/fix',
        pushedCommitSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      })

      expect(next.status).toBe('pending')
      expect(next.loopCount).toBe(0)
      expect(failed.status).toBe('failed')
      expect(failed.failureMessage).toBe('push failed')
      expect(failed.result).toEqual({ ok: false })
      expect(failed.sourceBranch).toBe('feature/fix')
      expect(failed.pushedCommitSha).toBe('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')

      const failedAgain = await failFixBatchRun({
        projectKey,
        mrIid,
        failureMessage: 'runner cleanup failed',
      })

      expect(failedAgain.failureMessage).toBe('runner cleanup failed')
      expect(failedAgain.result).toEqual({ ok: false })
      expect(failedAgain.pushedCommitSha).toBe('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
    })

    test('recovers interrupted running batches for startup resume', async () => {
      await upsertPendingFixBatch({
        projectKey,
        mrIid,
        force: false,
        acceptedFindingIds: ['finding-1'],
        pendingFindingIds: [],
      })
      await startFixBatchRun({ projectKey, mrIid, maxLoops: 3 })

      expect(await recoverFixBatchesAfterRestart()).toBe(1)

      const runnable = await listRunnableFixBatches()
      const recovered = runnable.find((row) => row.projectKey === projectKey && row.mrIid === mrIid)
      expect(recovered?.status).toBe('pending')
      expect(recovered?.loopCount).toBe(1)
    })

    test('does not retry interrupted batches after a fix commit was pushed', async () => {
      await upsertPendingFixBatch({
        projectKey,
        mrIid,
        force: false,
        acceptedFindingIds: ['finding-1'],
        pendingFindingIds: [],
      })
      await startFixBatchRun({ projectKey, mrIid, maxLoops: 3 })
      await recordFixBatchPush({
        projectKey,
        mrIid,
        sourceBranch: 'feature/fix',
        pushedCommitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        result: { pushed: true },
      })

      expect(await recoverFixBatchesAfterRestart()).toBe(1)

      const runnable = await listRunnableFixBatches()
      const recoveredRunnable = runnable.find(
        (row) => row.projectKey === projectKey && row.mrIid === mrIid,
      )
      const [recovered] = await getDb()
        .select()
        .from(mrFixBatches)
        .where(eq(mrFixBatches.projectKey, projectKey))
        .limit(1)

      expect(recoveredRunnable).toBeUndefined()
      expect(recovered?.status).toBe('failed')
      expect(recovered?.pushedCommitSha).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
      expect(recovered?.failureMessage).toContain('not retrying automatically')
    })

    test('preserves automatic loop count when requeueing after a completed pass', async () => {
      await upsertPendingFixBatch({
        projectKey,
        mrIid,
        force: true,
        acceptedFindingIds: ['finding-1'],
        pendingFindingIds: [],
      })
      await startFixBatchRun({ projectKey, mrIid, maxLoops: 3 })
      await completeFixBatchRun({
        projectKey,
        mrIid,
        sourceBranch: 'feature/fix',
        pushedCommitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        result: { ok: true },
      })

      const next = await upsertPendingFixBatch({
        projectKey,
        mrIid,
        force: true,
        acceptedFindingIds: ['finding-2'],
        pendingFindingIds: [],
        resetLoopCount: false,
      })

      expect(next.status).toBe('pending')
      expect(next.loopCount).toBe(1)
      await expect(startFixBatchRun({ projectKey, mrIid, maxLoops: 1 })).rejects.toThrow(
        'loop limit reached',
      )
    })

    test('enforces the configured loop limit before starting', async () => {
      await upsertPendingFixBatch({
        projectKey,
        mrIid,
        force: false,
        acceptedFindingIds: ['finding-1'],
        pendingFindingIds: [],
      })

      await getDb()
        .update(mrFixBatches)
        .set({ loopCount: 1 })
        .where(eq(mrFixBatches.projectKey, projectKey))

      await expect(startFixBatchRun({ projectKey, mrIid, maxLoops: 1 })).rejects.toThrow(
        'loop limit reached',
      )
    })
  }
})
