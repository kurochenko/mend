import { and, count, eq } from 'drizzle-orm'
import type { InferSelectModel } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { reviewFindings, type ReviewFindingState } from '@/db/schema'
import type { ReviewProvider } from '@/lib/review-threads'

export type ReviewFindingRecord = InferSelectModel<typeof reviewFindings>

type ReviewFindingSeverity = 'bug' | 'security' | 'performance' | 'suggestion'

type ReviewFindingSeverityCounts = Record<ReviewFindingSeverity, number>

interface UpsertReviewFindingParams {
  projectKey: string
  mrIid: number
  reviewRunId?: string | null
  threadId: string
  provider: ReviewProvider
  providerThreadId: string
  providerNoteId?: string | null
  metadata?: unknown
}

interface UpdateReviewFindingStateParams {
  id: string
  state: ReviewFindingState
  decisionReason?: string | null
  decidedByExternalId?: string | null
  decidedByName?: string | null
  decidedAt?: Date | null
}

export const upsertReviewFinding = async (
  params: UpsertReviewFindingParams,
): Promise<ReviewFindingRecord> => {
  const db = getDb()
  const now = new Date()
  const [row] = await db
    .insert(reviewFindings)
    .values({
      id: crypto.randomUUID(),
      projectKey: params.projectKey,
      mrIid: params.mrIid,
      reviewRunId: params.reviewRunId ?? null,
      threadId: params.threadId,
      provider: params.provider,
      providerThreadId: params.providerThreadId,
      providerNoteId: params.providerNoteId ?? null,
      state: 'pending',
      decisionReason: null,
      decidedByExternalId: null,
      decidedByName: null,
      decidedAt: null,
      metadata: params.metadata ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [reviewFindings.provider, reviewFindings.providerThreadId],
      set: {
        projectKey: params.projectKey,
        mrIid: params.mrIid,
        reviewRunId: params.reviewRunId ?? null,
        threadId: params.threadId,
        providerNoteId: params.providerNoteId ?? null,
        metadata: params.metadata ?? null,
        updatedAt: now,
      },
    })
    .returning()

  if (!row) {
    throw new Error(`Failed to upsert review finding ${params.provider}:${params.providerThreadId}`)
  }

  return row
}

export const getReviewFindingByProviderThreadId = async (params: {
  provider: ReviewProvider
  providerThreadId: string
}): Promise<ReviewFindingRecord | null> => {
  const db = getDb()
  const [row] = await db
    .select()
    .from(reviewFindings)
    .where(
      and(
        eq(reviewFindings.provider, params.provider),
        eq(reviewFindings.providerThreadId, params.providerThreadId),
      ),
    )
    .limit(1)

  return row ?? null
}

export const getReviewFindingByThreadId = async (
  threadId: string,
): Promise<ReviewFindingRecord | null> => {
  const db = getDb()
  const [row] = await db
    .select()
    .from(reviewFindings)
    .where(eq(reviewFindings.threadId, threadId))
    .limit(1)

  return row ?? null
}

export const listReviewFindingsForMr = async (params: {
  projectKey: string
  mrIid: number
}): Promise<ReviewFindingRecord[]> => {
  const db = getDb()
  return await db
    .select()
    .from(reviewFindings)
    .where(
      and(eq(reviewFindings.projectKey, params.projectKey), eq(reviewFindings.mrIid, params.mrIid)),
    )
}

export const updateReviewFindingState = async (
  params: UpdateReviewFindingStateParams,
): Promise<ReviewFindingRecord | null> => {
  const db = getDb()
  const [row] = await db
    .update(reviewFindings)
    .set({
      state: params.state,
      decisionReason: params.decisionReason ?? null,
      decidedByExternalId: params.decidedByExternalId ?? null,
      decidedByName: params.decidedByName ?? null,
      decidedAt: params.decidedAt ?? new Date(),
      updatedAt: new Date(),
    })
    .where(eq(reviewFindings.id, params.id))
    .returning()

  return row ?? null
}

export const countReviewFindingsByStateForMr = async (params: {
  projectKey: string
  mrIid: number
}): Promise<Partial<Record<ReviewFindingState, number>>> => {
  const db = getDb()
  const rows = await db
    .select({
      state: reviewFindings.state,
      total: count(),
    })
    .from(reviewFindings)
    .where(
      and(eq(reviewFindings.projectKey, params.projectKey), eq(reviewFindings.mrIid, params.mrIid)),
    )
    .groupBy(reviewFindings.state)

  return Object.fromEntries(rows.map((row) => [row.state, row.total]))
}

export const countReviewFindingSeveritiesForMr = async (params: {
  projectKey: string
  mrIid: number
}): Promise<ReviewFindingSeverityCounts> => {
  const db = getDb()
  const rows = await db
    .select({ metadata: reviewFindings.metadata })
    .from(reviewFindings)
    .where(
      and(eq(reviewFindings.projectKey, params.projectKey), eq(reviewFindings.mrIid, params.mrIid)),
    )

  const counts: ReviewFindingSeverityCounts = {
    bug: 0,
    security: 0,
    performance: 0,
    suggestion: 0,
  }

  for (const row of rows) {
    if (!row.metadata || typeof row.metadata !== 'object') {
      continue
    }

    const metadata = row.metadata as Record<string, unknown>
    const value =
      metadata.kind === 'finding'
        ? metadata.finding
        : metadata.kind === 'inline_comment'
          ? metadata.inlineComment
          : null

    if (!value || typeof value !== 'object') {
      continue
    }

    const severity = (value as Record<string, unknown>).severity
    switch (severity) {
      case 'bug':
      case 'security':
      case 'performance':
      case 'suggestion':
        counts[severity] += 1
    }
  }

  return counts
}
