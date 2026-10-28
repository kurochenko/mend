import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { closeDb, getDb, initDb } from '@/db/client'
import { getReviewQueueRecord, recoverReviewQueueAfterRestart } from '@/db/review-queue'
import { mrReviewQueue } from '@/db/schema'

const testDatabaseUrl = process.env.TEST_DATABASE_URL ?? ''
const projectKey = `review-queue-test-${crypto.randomUUID()}`
const mrIid = 42

const event = (title: string) => ({
  projectKey,
  mrIid,
  title,
  description: '',
  labels: [],
  sourceBranch: 'feature',
  targetBranch: 'main',
  url: 'https://example.test/mr/42',
})

const deleteTestRows = async () => {
  await getDb().delete(mrReviewQueue).where(eq(mrReviewQueue.projectKey, projectKey))
}

const insertRow = async (values: Partial<typeof mrReviewQueue.$inferInsert>) => {
  await getDb()
    .insert(mrReviewQueue)
    .values({
      id: `${projectKey}:${mrIid}`,
      projectKey,
      mrIid,
      ...values,
    })
}

describe.skipIf(testDatabaseUrl === '')('recoverReviewQueueAfterRestart', () => {
  beforeAll(async () => {
    await initDb(testDatabaseUrl)
  })

  beforeEach(async () => {
    await deleteTestRows()
  })

  afterAll(async () => {
    try {
      await deleteTestRows()
    } finally {
      await closeDb()
    }
  })

  test('re-queues an interrupted running review with its own SHA', async () => {
    await insertRow({
      runningEvent: event('running'),
      runningPayload: { kind: 'running' },
      runningCommitSha: 'running-sha',
    })

    await recoverReviewQueueAfterRestart()

    const row = await getReviewQueueRecord(projectKey, mrIid)
    expect(row?.runningEvent).toBeNull()
    expect(row?.pendingEvent).toEqual(event('running'))
    expect(row?.pendingPayload).toEqual({ kind: 'running' })
    expect(row?.pendingCommitSha).toBe('running-sha')
  })

  test('keeps a newer unpinned pending request without borrowing the running SHA', async () => {
    await insertRow({
      runningEvent: event('running'),
      runningPayload: { kind: 'running' },
      runningCommitSha: 'running-sha',
      pendingEvent: event('pending'),
      pendingPayload: { kind: 'pending' },
      pendingCommitSha: null,
    })

    await recoverReviewQueueAfterRestart()

    const row = await getReviewQueueRecord(projectKey, mrIid)
    expect(row?.runningEvent).toBeNull()
    expect(row?.pendingEvent).toEqual(event('pending'))
    expect(row?.pendingPayload).toEqual({ kind: 'pending' })
    expect(row?.pendingCommitSha).toBeNull()
  })
})
