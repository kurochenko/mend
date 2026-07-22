import { and, eq, inArray } from 'drizzle-orm'
import type { InferSelectModel } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { mrFixBatches, type FixBatchStatus } from '@/db/schema'

export type FixBatchRecord = InferSelectModel<typeof mrFixBatches>

const batchId = (projectKey: string, mrIid: number): string => `${projectKey}:${mrIid}`

export const getFixBatchRecord = async (
  projectKey: string,
  mrIid: number,
): Promise<FixBatchRecord | null> => {
  const db = getDb()
  const [row] = await db
    .select()
    .from(mrFixBatches)
    .where(and(eq(mrFixBatches.projectKey, projectKey), eq(mrFixBatches.mrIid, mrIid)))
    .limit(1)

  return row ?? null
}

export const listRunnableFixBatches = async (): Promise<FixBatchRecord[]> => {
  const db = getDb()
  return await db
    .select()
    .from(mrFixBatches)
    .where(inArray(mrFixBatches.status, ['pending', 'running']))
}

export const recoverFixBatchesAfterRestart = async (): Promise<number> => {
  const db = getDb()
  const rows = await db.select().from(mrFixBatches).where(eq(mrFixBatches.status, 'running'))

  for (const row of rows) {
    const pushedCommitSha = row.pushedCommitSha
    await db
      .update(mrFixBatches)
      .set({
        status: pushedCommitSha ? 'failed' : 'pending',
        failureMessage: pushedCommitSha
          ? `Interrupted after pushing fix commit ${pushedCommitSha}; not retrying automatically`
          : null,
        updatedAt: new Date(),
      })
      .where(eq(mrFixBatches.id, row.id))
  }

  return rows.length
}

interface UpsertPendingFixBatchParams {
  projectKey: string
  mrIid: number
  force: boolean
  requestNoteId?: string | null
  requestThreadId?: string | null
  requestedByExternalId?: string | null
  requestedByName?: string | null
  acceptedFindingIds: string[]
  pendingFindingIds: string[]
  resetLoopCount?: boolean
}

const pendingFixBatchValues = (
  params: UpsertPendingFixBatchParams,
  existing: FixBatchRecord | null,
  now: Date,
) => ({
  id: batchId(params.projectKey, params.mrIid),
  projectKey: params.projectKey,
  mrIid: params.mrIid,
  status: 'pending' as FixBatchStatus,
  force: params.force,
  loopCount: params.resetLoopCount === false ? (existing?.loopCount ?? 0) : 0,
  requestNoteId: params.requestNoteId ?? null,
  requestThreadId: params.requestThreadId ?? null,
  requestedByExternalId: params.requestedByExternalId ?? null,
  requestedByName: params.requestedByName ?? null,
  acceptedFindingIds: params.acceptedFindingIds,
  pendingFindingIds: params.pendingFindingIds,
  sourceBranch: null,
  pushedCommitSha: null,
  result: null,
  failureMessage: null,
  updatedAt: now,
})

export const upsertPendingFixBatch = async (
  params: UpsertPendingFixBatchParams,
): Promise<FixBatchRecord> => {
  const existing = await getFixBatchRecord(params.projectKey, params.mrIid)
  if (existing?.status === 'pending' || existing?.status === 'running') {
    return existing
  }

  const db = getDb()
  const now = new Date()
  const values = pendingFixBatchValues(params, existing, now)

  const [row] = await db
    .insert(mrFixBatches)
    .values({ ...values, createdAt: now })
    .onConflictDoUpdate({
      target: [mrFixBatches.projectKey, mrFixBatches.mrIid],
      set: values,
    })
    .returning()

  if (!row) {
    throw new Error(`Failed to queue fix batch for ${params.projectKey} MR !${params.mrIid}`)
  }

  return row
}

export const recordFixBatchPush = async (params: {
  projectKey: string
  mrIid: number
  sourceBranch: string
  pushedCommitSha: string
  result: unknown
}): Promise<FixBatchRecord> => {
  const db = getDb()
  const [row] = await db
    .update(mrFixBatches)
    .set({
      sourceBranch: params.sourceBranch,
      pushedCommitSha: params.pushedCommitSha,
      result: params.result,
      failureMessage: null,
      updatedAt: new Date(),
    })
    .where(
      and(eq(mrFixBatches.projectKey, params.projectKey), eq(mrFixBatches.mrIid, params.mrIid)),
    )
    .returning()

  if (!row) {
    throw new Error(`Failed to record fix batch push for ${params.projectKey} MR !${params.mrIid}`)
  }

  return row
}

export const startFixBatchRun = async (params: {
  projectKey: string
  mrIid: number
  maxLoops: number
}): Promise<FixBatchRecord> => {
  const existing = await getFixBatchRecord(params.projectKey, params.mrIid)
  if (!existing) {
    throw new Error(`Fix batch not found for ${params.projectKey} MR !${params.mrIid}`)
  }

  if (existing.status === 'running') {
    return existing
  }

  if (existing.status !== 'pending') {
    throw new Error(
      `Fix batch for ${params.projectKey} MR !${params.mrIid} is ${existing.status}, not pending`,
    )
  }

  if (existing.loopCount >= params.maxLoops) {
    throw new Error(
      `Fix batch loop limit reached for ${params.projectKey} MR !${params.mrIid}: ${existing.loopCount}/${params.maxLoops}`,
    )
  }

  const db = getDb()
  const [row] = await db
    .update(mrFixBatches)
    .set({
      status: 'running',
      loopCount: existing.loopCount + 1,
      updatedAt: new Date(),
    })
    .where(
      and(eq(mrFixBatches.projectKey, params.projectKey), eq(mrFixBatches.mrIid, params.mrIid)),
    )
    .returning()

  if (!row) {
    throw new Error(`Failed to start fix batch for ${params.projectKey} MR !${params.mrIid}`)
  }

  return row
}

export const completeFixBatchRun = async (params: {
  projectKey: string
  mrIid: number
  sourceBranch: string
  pushedCommitSha: string
  result: unknown
}): Promise<FixBatchRecord> => {
  const db = getDb()
  const [row] = await db
    .update(mrFixBatches)
    .set({
      status: 'completed',
      sourceBranch: params.sourceBranch,
      pushedCommitSha: params.pushedCommitSha,
      result: params.result,
      failureMessage: null,
      updatedAt: new Date(),
    })
    .where(
      and(eq(mrFixBatches.projectKey, params.projectKey), eq(mrFixBatches.mrIid, params.mrIid)),
    )
    .returning()

  if (!row) {
    throw new Error(`Failed to complete fix batch for ${params.projectKey} MR !${params.mrIid}`)
  }

  return row
}

export const failFixBatchRun = async (params: {
  projectKey: string
  mrIid: number
  failureMessage: string
  result?: unknown
  sourceBranch?: string
  pushedCommitSha?: string
}): Promise<FixBatchRecord> => {
  const db = getDb()
  const values: Partial<typeof mrFixBatches.$inferInsert> = {
    status: 'failed',
    failureMessage: params.failureMessage,
    updatedAt: new Date(),
  }
  if (params.result !== undefined) {
    values.result = params.result
  }
  if (params.sourceBranch) {
    values.sourceBranch = params.sourceBranch
  }
  if (params.pushedCommitSha) {
    values.pushedCommitSha = params.pushedCommitSha
  }

  const [row] = await db
    .update(mrFixBatches)
    .set(values)
    .where(
      and(eq(mrFixBatches.projectKey, params.projectKey), eq(mrFixBatches.mrIid, params.mrIid)),
    )
    .returning()

  if (!row) {
    throw new Error(`Failed to fail fix batch for ${params.projectKey} MR !${params.mrIid}`)
  }

  return row
}
