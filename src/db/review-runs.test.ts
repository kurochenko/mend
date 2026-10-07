import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { closeDb, getDb, initDb } from '@/db/client'
import {
  countPostedSuccessfulReviewRuns,
  getLatestSuccessfulReviewRun,
  hasSuccessfulReviewRunForSha,
  type ReviewRunSource,
} from '@/db/review-runs'
import { reviewRuns } from '@/db/schema'

const testDatabaseUrl = process.env.TEST_DATABASE_URL ?? ''
const projectKey = `review-runs-test-${crypto.randomUUID()}`
const mrIid = 42
const sha = 'test-commit-sha'

const deleteTestRows = async () => {
  await getDb().delete(reviewRuns).where(eq(reviewRuns.projectKey, projectKey))
}

const createSuccessfulRun = async (source: ReviewRunSource, createdAt = new Date()) => {
  const id = crypto.randomUUID()
  await getDb()
    .insert(reviewRuns)
    .values({
      id,
      projectKey,
      mrIid,
      commitSha: sha,
      model: 'test-model',
      source,
      status: 'success',
      input: {},
      result: { summaryNoteId: 1 },
      createdAt,
    })
  return id
}

describe.skipIf(testDatabaseUrl === '')('successful review run history', () => {
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

  test('ignores successful benchmark runs', async () => {
    await createSuccessfulRun('replay_benchmark')

    expect(await getLatestSuccessfulReviewRun({ projectKey, mrIid })).toBeNull()
    expect(await hasSuccessfulReviewRunForSha({ projectKey, mrIid, sha })).toBe(false)
    expect(await countPostedSuccessfulReviewRuns({ projectKey, mrIid })).toBe(0)
  })

  for (const source of ['webhook', 'replay_iid', 'replay_run'] satisfies ReviewRunSource[]) {
    test(`includes successful ${source} runs despite a newer benchmark`, async () => {
      const id = await createSuccessfulRun(source, new Date('2026-01-01T00:00:00Z'))
      await createSuccessfulRun('replay_benchmark', new Date('2026-01-02T00:00:00Z'))

      expect((await getLatestSuccessfulReviewRun({ projectKey, mrIid }))?.id).toBe(id)
      expect(await hasSuccessfulReviewRunForSha({ projectKey, mrIid, sha })).toBe(true)
      expect(await countPostedSuccessfulReviewRuns({ projectKey, mrIid })).toBe(1)
    })
  }
})
