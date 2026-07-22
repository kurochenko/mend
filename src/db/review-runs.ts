import { and, desc, eq, type SQL } from 'drizzle-orm'
import type { InferSelectModel } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { reviewRunStatusEnum, reviewRuns } from '@/db/schema'
import type { MrReviewInput } from '@/lib/review-run-input'

export type ReviewRunRecord = InferSelectModel<typeof reviewRuns>
export type ReviewRunStatus = (typeof reviewRunStatusEnum.enumValues)[number]
export type ReviewRunSource = 'webhook' | 'replay_iid' | 'replay_run' | 'replay_benchmark'

interface CreateReviewRunParams {
  id: string
  projectKey: string
  mrIid: number
  commitSha?: string
  model: string
  source: ReviewRunSource
  webhookPayload?: unknown
  input: MrReviewInput
  workflowRunId?: string
}

interface CompleteReviewRunParams {
  id: string
  commitSha?: string
  workflowRunId?: string
  durationMs: number
  result: unknown
  comparisonResult?: unknown
}

interface FailReviewRunParams {
  id: string
  commitSha?: string
  workflowRunId?: string
  durationMs: number
  error: string
  result?: unknown
}

interface UpdateReviewRunResultParams {
  id: string
  result: unknown
  comparisonResult?: unknown
}

interface ListReviewRunsParams {
  projectKey?: string
  mrIid?: number
  limit?: number
}

interface SuccessfulRunLookupParams {
  projectKey: string
  mrIid: number
}

interface SuccessfulRunForShaLookupParams extends SuccessfulRunLookupParams {
  sha: string
}

const buildWhere = (params: ListReviewRunsParams): SQL | undefined => {
  const conditions: SQL[] = []
  if (params.projectKey) {
    conditions.push(eq(reviewRuns.projectKey, params.projectKey))
  }
  if (params.mrIid !== undefined) {
    conditions.push(eq(reviewRuns.mrIid, params.mrIid))
  }
  if (conditions.length === 0) {
    return undefined
  }
  if (conditions.length === 1) {
    return conditions[0]
  }
  return and(...conditions)
}

export const createReviewRun = async (params: CreateReviewRunParams): Promise<void> => {
  const db = getDb()
  await db.insert(reviewRuns).values({
    id: params.id,
    projectKey: params.projectKey,
    mrIid: params.mrIid,
    commitSha: params.commitSha ?? null,
    model: params.model,
    source: params.source,
    status: 'running',
    workflowRunId: params.workflowRunId ?? null,
    webhookPayload: params.webhookPayload ?? null,
    input: params.input,
  })
}

export const completeReviewRun = async (params: CompleteReviewRunParams): Promise<void> => {
  const db = getDb()
  await db
    .update(reviewRuns)
    .set({
      status: 'success',
      commitSha: params.commitSha,
      workflowRunId: params.workflowRunId,
      result: params.result,
      comparisonResult: params.comparisonResult ?? null,
      durationMs: params.durationMs,
      completedAt: new Date(),
      error: null,
    })
    .where(eq(reviewRuns.id, params.id))
}

export const failReviewRun = async (params: FailReviewRunParams): Promise<void> => {
  const db = getDb()
  await db
    .update(reviewRuns)
    .set({
      status: 'failed',
      commitSha: params.commitSha,
      workflowRunId: params.workflowRunId,
      result: params.result ?? null,
      comparisonResult: null,
      durationMs: params.durationMs,
      completedAt: new Date(),
      error: params.error,
    })
    .where(eq(reviewRuns.id, params.id))
}

export const updateReviewRunResult = async (params: UpdateReviewRunResultParams): Promise<void> => {
  const db = getDb()
  await db
    .update(reviewRuns)
    .set({
      result: params.result,
      comparisonResult: params.comparisonResult ?? null,
    })
    .where(eq(reviewRuns.id, params.id))
}

export const getReviewRun = async (id: string): Promise<ReviewRunRecord | null> => {
  const db = getDb()
  const [row] = await db.select().from(reviewRuns).where(eq(reviewRuns.id, id)).limit(1)
  return row ?? null
}

export const recoverOrphanedRuns = async (): Promise<number> => {
  const db = getDb()
  const orphans = await db
    .update(reviewRuns)
    .set({
      status: 'failed',
      error: 'Aborted: service restarted while review was in progress',
      completedAt: new Date(),
    })
    .where(eq(reviewRuns.status, 'running'))
    .returning({
      id: reviewRuns.id,
      projectKey: reviewRuns.projectKey,
      mrIid: reviewRuns.mrIid,
    })

  for (const orphan of orphans) {
    console.log(
      `[startup] marked orphaned run ${orphan.id} as failed (${orphan.projectKey} MR !${orphan.mrIid})`,
    )
  }

  return orphans.length
}

export const listReviewRuns = async (params: ListReviewRunsParams): Promise<ReviewRunRecord[]> => {
  const db = getDb()
  const where = buildWhere(params)
  const limit = params.limit ?? 20

  if (!where) {
    return await db.select().from(reviewRuns).orderBy(desc(reviewRuns.createdAt)).limit(limit)
  }

  return await db
    .select()
    .from(reviewRuns)
    .where(where)
    .orderBy(desc(reviewRuns.createdAt))
    .limit(limit)
}

export const getLatestSuccessfulReviewRun = async (
  params: SuccessfulRunLookupParams,
): Promise<ReviewRunRecord | null> => {
  const db = getDb()
  const [row] = await db
    .select()
    .from(reviewRuns)
    .where(
      and(
        eq(reviewRuns.projectKey, params.projectKey),
        eq(reviewRuns.mrIid, params.mrIid),
        eq(reviewRuns.status, 'success'),
      ),
    )
    .orderBy(desc(reviewRuns.createdAt))
    .limit(1)

  return row ?? null
}

export const hasSuccessfulReviewRunForSha = async (
  params: SuccessfulRunForShaLookupParams,
): Promise<boolean> => {
  const db = getDb()
  const [row] = await db
    .select({ id: reviewRuns.id })
    .from(reviewRuns)
    .where(
      and(
        eq(reviewRuns.projectKey, params.projectKey),
        eq(reviewRuns.mrIid, params.mrIid),
        eq(reviewRuns.commitSha, params.sha),
        eq(reviewRuns.status, 'success'),
      ),
    )
    .limit(1)

  return row !== undefined
}

const hasPostedSummaryNote = (result: unknown): boolean => {
  if (!result || typeof result !== 'object') {
    return false
  }

  const summaryNoteId = (result as Record<string, unknown>).summaryNoteId
  return typeof summaryNoteId === 'number' && summaryNoteId > 0
}

export const countPostedSuccessfulReviewRuns = async (
  params: SuccessfulRunLookupParams,
): Promise<number> => {
  const db = getDb()
  const rows = await db
    .select({ result: reviewRuns.result })
    .from(reviewRuns)
    .where(
      and(
        eq(reviewRuns.projectKey, params.projectKey),
        eq(reviewRuns.mrIid, params.mrIid),
        eq(reviewRuns.status, 'success'),
      ),
    )

  return rows.filter((row) => hasPostedSummaryNote(row.result)).length
}
