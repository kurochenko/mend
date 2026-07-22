import { eq, isNotNull, or } from 'drizzle-orm'
import type { InferSelectModel } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { mrReviewQueue } from '@/db/schema'
import { asMrReviewRequestEvent, type MrReviewRequestEvent } from '@/lib/review-events'

export type ReviewQueueRecord = InferSelectModel<typeof mrReviewQueue>

export interface ReviewQueueJob {
  id: string
  projectKey: string
  mrIid: number
  event: MrReviewRequestEvent
  payload: unknown
  commitSha: string | null
}

const queueId = (projectKey: string, mrIid: number): string => `${projectKey}:${mrIid}`

export const getReviewQueueRecord = async (
  projectKey: string,
  mrIid: number,
): Promise<ReviewQueueRecord | null> => {
  const db = getDb()
  const [row] = await db
    .select()
    .from(mrReviewQueue)
    .where(eq(mrReviewQueue.id, queueId(projectKey, mrIid)))
    .limit(1)

  return row ?? null
}

export const upsertPendingReviewRequest = async (params: {
  event: MrReviewRequestEvent
  payload: unknown
}): Promise<ReviewQueueRecord> => {
  const db = getDb()
  const id = queueId(params.event.projectKey, params.event.mrIid)
  const existing = await getReviewQueueRecord(params.event.projectKey, params.event.mrIid)
  const now = new Date()

  if (!existing) {
    const [created] = await db
      .insert(mrReviewQueue)
      .values({
        id,
        projectKey: params.event.projectKey,
        mrIid: params.event.mrIid,
        pendingEvent: params.event,
        pendingPayload: params.payload,
        pendingCommitSha: null,
        createdAt: now,
        updatedAt: now,
      })
      .returning()

    if (!created) {
      throw new Error(`Failed to create queue row ${id}`)
    }

    return created
  }

  const [updated] = await db
    .update(mrReviewQueue)
    .set({
      pendingEvent: params.event,
      pendingPayload: params.payload,
      pendingCommitSha: null,
      updatedAt: now,
    })
    .where(eq(mrReviewQueue.id, id))
    .returning()

  if (!updated) {
    throw new Error(`Failed to update queue row ${id}`)
  }

  return updated
}

export const claimPendingReviewJob = async (
  projectKey: string,
  mrIid: number,
): Promise<ReviewQueueJob | null> => {
  const db = getDb()
  const existing = await getReviewQueueRecord(projectKey, mrIid)
  if (!existing || existing.runningEvent || !existing.pendingEvent) {
    return null
  }

  const event = asMrReviewRequestEvent(existing.pendingEvent)
  if (!event) {
    await db.delete(mrReviewQueue).where(eq(mrReviewQueue.id, existing.id))
    return null
  }

  const [updated] = await db
    .update(mrReviewQueue)
    .set({
      runningEvent: existing.pendingEvent,
      runningPayload: existing.pendingPayload,
      runningCommitSha: existing.pendingCommitSha,
      pendingEvent: null,
      pendingPayload: null,
      pendingCommitSha: null,
      updatedAt: new Date(),
    })
    .where(eq(mrReviewQueue.id, existing.id))
    .returning()

  if (!updated) {
    return null
  }

  return {
    id: updated.id,
    projectKey: updated.projectKey,
    mrIid: updated.mrIid,
    event,
    payload: existing.pendingPayload,
    commitSha: existing.pendingCommitSha,
  }
}

export const setPendingCommitSha = async (
  projectKey: string,
  mrIid: number,
  commitSha: string,
): Promise<ReviewQueueRecord | null> => {
  const db = getDb()
  const [updated] = await db
    .update(mrReviewQueue)
    .set({
      pendingCommitSha: commitSha,
      updatedAt: new Date(),
    })
    .where(eq(mrReviewQueue.id, queueId(projectKey, mrIid)))
    .returning()

  return updated ?? null
}

export const setRunningCommitSha = async (
  projectKey: string,
  mrIid: number,
  commitSha: string,
): Promise<void> => {
  const db = getDb()
  await db
    .update(mrReviewQueue)
    .set({
      runningCommitSha: commitSha,
      updatedAt: new Date(),
    })
    .where(eq(mrReviewQueue.id, queueId(projectKey, mrIid)))
}

export const finishRunningReview = async (
  projectKey: string,
  mrIid: number,
): Promise<ReviewQueueRecord | null> => {
  const db = getDb()
  const existing = await getReviewQueueRecord(projectKey, mrIid)
  if (!existing) {
    return null
  }

  if (existing.pendingEvent) {
    const [updated] = await db
      .update(mrReviewQueue)
      .set({
        runningEvent: null,
        runningPayload: null,
        runningCommitSha: null,
        updatedAt: new Date(),
      })
      .where(eq(mrReviewQueue.id, existing.id))
      .returning()

    return updated ?? null
  }

  await db.delete(mrReviewQueue).where(eq(mrReviewQueue.id, existing.id))

  return null
}

export const deleteReviewQueueRecord = async (id: string): Promise<void> => {
  const db = getDb()
  await db.delete(mrReviewQueue).where(eq(mrReviewQueue.id, id))
}

export const recoverReviewQueueAfterRestart = async (): Promise<number> => {
  const db = getDb()
  const rows = await db.select().from(mrReviewQueue).where(isNotNull(mrReviewQueue.runningEvent))

  for (const row of rows) {
    await db
      .update(mrReviewQueue)
      .set({
        pendingEvent: row.pendingEvent ?? row.runningEvent,
        pendingPayload: row.pendingPayload ?? row.runningPayload,
        pendingCommitSha: row.pendingCommitSha ?? row.runningCommitSha,
        runningEvent: null,
        runningPayload: null,
        runningCommitSha: null,
        updatedAt: new Date(),
      })
      .where(eq(mrReviewQueue.id, row.id))
  }

  return rows.length
}

export const listReviewQueueRecords = async (): Promise<ReviewQueueRecord[]> => {
  const db = getDb()
  return await db
    .select()
    .from(mrReviewQueue)
    .where(or(isNotNull(mrReviewQueue.runningEvent), isNotNull(mrReviewQueue.pendingEvent)))
}

export const countRunningReviewQueueEntries = async (): Promise<number> => {
  const rows = await listReviewQueueRecords()
  return rows.filter((row) => row.runningEvent !== null).length
}

export const countPendingReviewQueueEntries = async (): Promise<number> => {
  const rows = await listReviewQueueRecords()
  return rows.filter((row) => row.pendingEvent !== null).length
}
