import { and, asc, eq, isNull, lt, or } from 'drizzle-orm'
import type { InferSelectModel } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { reviewMessages, reviewThreads } from '@/db/schema'
import {
  normalizeReviewMessageBody,
  type ReviewMessageAuthorType,
  type ReviewMessageDirection,
  type ReviewProvider,
  type ReviewSubjectType,
  type ReviewThreadKind,
  type ReviewThreadStatus,
} from '@/lib/review-threads'

export type ReviewThreadRecord = InferSelectModel<typeof reviewThreads>
export type ReviewMessageRecord = InferSelectModel<typeof reviewMessages>

interface UpsertReviewThreadParams {
  provider: ReviewProvider
  projectKey: string
  repoExternalId: string
  reviewExternalId: number
  reviewRunId?: string | null
  threadKind: ReviewThreadKind
  subjectType: ReviewSubjectType
  path?: string | null
  line?: number | null
  findingFingerprint?: string | null
  status: ReviewThreadStatus
  providerThreadId: string
  providerUrl?: string | null
  rawProviderData?: unknown
  providerCreatedAt?: Date | null
  providerUpdatedAt?: Date | null
}

interface UpsertReviewMessageParams {
  threadId: string
  provider: ReviewProvider
  reviewRunId?: string | null
  authorType: ReviewMessageAuthorType
  authorExternalId?: string | null
  authorName?: string | null
  direction: ReviewMessageDirection
  body: string
  providerMessageId: string
  providerParentMessageId?: string | null
  providerUrl?: string | null
  rawProviderData?: unknown
  providerCreatedAt?: Date | null
  providerUpdatedAt?: Date | null
}

const withDefaultDate = (value?: Date | null): Date => value ?? new Date()

export const upsertReviewThread = async (
  params: UpsertReviewThreadParams,
): Promise<ReviewThreadRecord> => {
  const db = getDb()
  const now = new Date()
  const [row] = await db
    .insert(reviewThreads)
    .values({
      id: crypto.randomUUID(),
      provider: params.provider,
      projectKey: params.projectKey,
      repoExternalId: params.repoExternalId,
      reviewExternalId: params.reviewExternalId,
      reviewRunId: params.reviewRunId ?? null,
      threadKind: params.threadKind,
      subjectType: params.subjectType,
      path: params.path ?? null,
      line: params.line ?? null,
      findingFingerprint: params.findingFingerprint ?? null,
      status: params.status,
      providerThreadId: params.providerThreadId,
      providerUrl: params.providerUrl ?? null,
      rawProviderData: params.rawProviderData ?? null,
      providerCreatedAt: params.providerCreatedAt ?? null,
      providerUpdatedAt: params.providerUpdatedAt ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [reviewThreads.provider, reviewThreads.providerThreadId],
      set: {
        projectKey: params.projectKey,
        repoExternalId: params.repoExternalId,
        reviewExternalId: params.reviewExternalId,
        reviewRunId: params.reviewRunId ?? null,
        threadKind: params.threadKind,
        subjectType: params.subjectType,
        path: params.path ?? null,
        line: params.line ?? null,
        findingFingerprint: params.findingFingerprint ?? null,
        status: params.status,
        providerUrl: params.providerUrl ?? null,
        rawProviderData: params.rawProviderData ?? null,
        providerCreatedAt: params.providerCreatedAt ?? null,
        providerUpdatedAt: params.providerUpdatedAt ?? null,
        updatedAt: now,
      },
    })
    .returning()

  if (!row) {
    throw new Error(`Failed to upsert review thread ${params.provider}:${params.providerThreadId}`)
  }

  return row
}

export const upsertReviewMessage = async (
  params: UpsertReviewMessageParams,
): Promise<ReviewMessageRecord> => {
  const db = getDb()
  const now = new Date()
  const bodyNormalized = normalizeReviewMessageBody(params.body)
  const row = await db.transaction(async (tx) => {
    const [message] = await tx
      .insert(reviewMessages)
      .values({
        id: crypto.randomUUID(),
        threadId: params.threadId,
        provider: params.provider,
        reviewRunId: params.reviewRunId ?? null,
        authorType: params.authorType,
        authorExternalId: params.authorExternalId ?? null,
        authorName: params.authorName ?? null,
        direction: params.direction,
        body: params.body,
        bodyNormalized,
        providerMessageId: params.providerMessageId,
        providerParentMessageId: params.providerParentMessageId ?? null,
        processingStatus: null,
        processingClaimedAt: null,
        providerUrl: params.providerUrl ?? null,
        rawProviderData: params.rawProviderData ?? null,
        providerCreatedAt: params.providerCreatedAt ?? null,
        providerUpdatedAt: params.providerUpdatedAt ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [reviewMessages.provider, reviewMessages.providerMessageId],
        set: {
          threadId: params.threadId,
          reviewRunId: params.reviewRunId ?? null,
          authorType: params.authorType,
          authorExternalId: params.authorExternalId ?? null,
          authorName: params.authorName ?? null,
          direction: params.direction,
          body: params.body,
          bodyNormalized,
          providerParentMessageId: params.providerParentMessageId ?? null,
          processingStatus: null,
          processingClaimedAt: null,
          providerUrl: params.providerUrl ?? null,
          rawProviderData: params.rawProviderData ?? null,
          providerCreatedAt: params.providerCreatedAt ?? null,
          providerUpdatedAt: params.providerUpdatedAt ?? null,
          updatedAt: now,
        },
      })
      .returning()

    await tx
      .update(reviewThreads)
      .set({
        updatedAt: now,
        providerUpdatedAt: withDefaultDate(params.providerUpdatedAt ?? params.providerCreatedAt),
      })
      .where(eq(reviewThreads.id, params.threadId))

    return message
  })

  if (!row) {
    throw new Error(
      `Failed to upsert review message ${params.provider}:${params.providerMessageId}`,
    )
  }

  return row
}

export const createReviewMessageIfAbsent = async (
  params: UpsertReviewMessageParams,
): Promise<ReviewMessageRecord | null> => {
  const db = getDb()
  const now = new Date()
  const bodyNormalized = normalizeReviewMessageBody(params.body)
  const processingStatus = params.direction === 'inbound' ? 'processing' : null
  const processingClaimedAt = params.direction === 'inbound' ? now : null

  return await db.transaction(async (tx) => {
    const [message] = await tx
      .insert(reviewMessages)
      .values({
        id: crypto.randomUUID(),
        threadId: params.threadId,
        provider: params.provider,
        reviewRunId: params.reviewRunId ?? null,
        authorType: params.authorType,
        authorExternalId: params.authorExternalId ?? null,
        authorName: params.authorName ?? null,
        direction: params.direction,
        body: params.body,
        bodyNormalized,
        providerMessageId: params.providerMessageId,
        providerParentMessageId: params.providerParentMessageId ?? null,
        processingStatus,
        processingClaimedAt,
        providerUrl: params.providerUrl ?? null,
        rawProviderData: params.rawProviderData ?? null,
        providerCreatedAt: params.providerCreatedAt ?? null,
        providerUpdatedAt: params.providerUpdatedAt ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({
        target: [reviewMessages.provider, reviewMessages.providerMessageId],
      })
      .returning()

    if (!message) {
      return null
    }

    await tx
      .update(reviewThreads)
      .set({
        updatedAt: now,
        providerUpdatedAt: withDefaultDate(params.providerUpdatedAt ?? params.providerCreatedAt),
      })
      .where(eq(reviewThreads.id, params.threadId))

    return message
  })
}

export const listReviewThreadsForRun = async (
  reviewRunId: string,
): Promise<ReviewThreadRecord[]> => {
  const db = getDb()
  return await db.select().from(reviewThreads).where(eq(reviewThreads.reviewRunId, reviewRunId))
}

export const listReviewThreadsForMr = async (params: {
  projectKey: string
  mrIid: number
}): Promise<ReviewThreadRecord[]> => {
  const db = getDb()
  return await db
    .select()
    .from(reviewThreads)
    .where(
      and(
        eq(reviewThreads.projectKey, params.projectKey),
        eq(reviewThreads.reviewExternalId, params.mrIid),
      ),
    )
}

export const getReviewThreadByProviderThreadId = async (params: {
  provider: ReviewProvider
  providerThreadId: string
}): Promise<ReviewThreadRecord | null> => {
  const db = getDb()
  const [row] = await db
    .select()
    .from(reviewThreads)
    .where(
      and(
        eq(reviewThreads.provider, params.provider),
        eq(reviewThreads.providerThreadId, params.providerThreadId),
      ),
    )
    .limit(1)

  return row ?? null
}

export const listReviewMessagesForThread = async (
  threadId: string,
): Promise<ReviewMessageRecord[]> => {
  const db = getDb()
  return await db
    .select()
    .from(reviewMessages)
    .where(eq(reviewMessages.threadId, threadId))
    .orderBy(asc(reviewMessages.createdAt))
}

export const getReviewMessageByProviderMessageId = async (params: {
  provider: ReviewProvider
  providerMessageId: string
}): Promise<ReviewMessageRecord | null> => {
  const db = getDb()
  const [row] = await db
    .select()
    .from(reviewMessages)
    .where(
      and(
        eq(reviewMessages.provider, params.provider),
        eq(reviewMessages.providerMessageId, params.providerMessageId),
      ),
    )
    .limit(1)

  return row ?? null
}

export const claimPendingReviewMessage = async (messageId: string): Promise<boolean> => {
  const db = getDb()
  const staleThreshold = new Date(Date.now() - 2 * 60 * 1000)
  const rows = await db
    .update(reviewMessages)
    .set({
      processingStatus: 'processing',
      processingClaimedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(reviewMessages.id, messageId),
        or(
          eq(reviewMessages.processingStatus, 'pending'),
          and(
            eq(reviewMessages.processingStatus, 'processing'),
            or(
              isNull(reviewMessages.processingClaimedAt),
              lt(reviewMessages.processingClaimedAt, staleThreshold),
            ),
          ),
        ),
      ),
    )
    .returning({ id: reviewMessages.id })

  return rows.length > 0
}

export const completeReviewMessageProcessing = async (messageId: string): Promise<void> => {
  const db = getDb()
  await db
    .update(reviewMessages)
    .set({
      processingStatus: 'completed',
      updatedAt: new Date(),
    })
    .where(eq(reviewMessages.id, messageId))
}

export const resetReviewMessageProcessing = async (messageId: string): Promise<void> => {
  const db = getDb()
  await db
    .update(reviewMessages)
    .set({
      processingStatus: 'pending',
      updatedAt: new Date(),
    })
    .where(eq(reviewMessages.id, messageId))
}

export const updateReviewThreadStatusByProviderThreadId = async (params: {
  provider: ReviewProvider
  providerThreadId: string
  status: ReviewThreadStatus
  providerUpdatedAt?: Date | null
}): Promise<void> => {
  const db = getDb()
  await db
    .update(reviewThreads)
    .set({
      status: params.status,
      providerUpdatedAt: params.providerUpdatedAt ?? new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(reviewThreads.provider, params.provider),
        eq(reviewThreads.providerThreadId, params.providerThreadId),
      ),
    )
}
