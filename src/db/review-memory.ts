import { and, desc, eq, isNull, or } from 'drizzle-orm'
import type { InferSelectModel } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { reviewMemoryEntries, reviewMemoryEvents } from '@/db/schema'

export type ReviewMemoryEntryRecord = InferSelectModel<typeof reviewMemoryEntries>
export type ReviewMemoryEventRecord = InferSelectModel<typeof reviewMemoryEvents>
export type ReviewMemoryScope = 'mr' | 'project'
export type ReviewMemoryStatus = 'active' | 'archived'
export const THREAD_RESOLVED_MEMORY_KIND = 'thread_resolved'

interface CreateReviewMemoryEntryParams {
  scope: ReviewMemoryScope
  projectKey: string
  mrIid?: number | null
  threadId?: string | null
  sourceMessageId?: string | null
  kind: string
  instruction: string
  matchFingerprint?: string | null
  matchPath?: string | null
  matchLine?: number | null
  matchCategory?: string | null
  metadata?: unknown
  createdByExternalId?: string | null
  createdByName?: string | null
}

interface CreateReviewMemoryEventParams {
  memoryEntryId?: string | null
  projectKey: string
  mrIid?: number | null
  threadId?: string | null
  messageId?: string | null
  eventType: string
  payload?: unknown
}

export const createReviewMemoryEntry = async (
  params: CreateReviewMemoryEntryParams,
): Promise<ReviewMemoryEntryRecord> => {
  const db = getDb()
  const now = new Date()
  const [row] = await db
    .insert(reviewMemoryEntries)
    .values({
      id: crypto.randomUUID(),
      scope: params.scope,
      status: 'active',
      projectKey: params.projectKey,
      mrIid: params.mrIid ?? null,
      threadId: params.threadId ?? null,
      sourceMessageId: params.sourceMessageId ?? null,
      kind: params.kind,
      instruction: params.instruction,
      matchFingerprint: params.matchFingerprint ?? null,
      matchPath: params.matchPath ?? null,
      matchLine: params.matchLine ?? null,
      matchCategory: params.matchCategory ?? null,
      metadata: params.metadata ?? null,
      createdByExternalId: params.createdByExternalId ?? null,
      createdByName: params.createdByName ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({
      target: reviewMemoryEntries.sourceMessageId,
    })
    .returning()

  if (row) {
    return row
  }

  if (!params.sourceMessageId) {
    throw new Error('Failed to create review memory entry')
  }

  const [existing] = await db
    .select()
    .from(reviewMemoryEntries)
    .where(eq(reviewMemoryEntries.sourceMessageId, params.sourceMessageId))
    .limit(1)

  if (!existing) {
    throw new Error('Failed to load existing review memory entry')
  }

  if (existing.status === 'active') {
    return existing
  }

  const [reactivated] = await db
    .update(reviewMemoryEntries)
    .set({
      status: 'active',
      updatedAt: now,
    })
    .where(eq(reviewMemoryEntries.id, existing.id))
    .returning()

  if (!reactivated) {
    throw new Error('Failed to reactivate existing review memory entry')
  }

  return reactivated
}

export const archiveActiveMemoryForThread = async (params: {
  projectKey: string
  threadId: string
}): Promise<void> => {
  const db = getDb()
  await db
    .update(reviewMemoryEntries)
    .set({
      status: 'archived',
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(reviewMemoryEntries.projectKey, params.projectKey),
        eq(reviewMemoryEntries.threadId, params.threadId),
        eq(reviewMemoryEntries.scope, 'mr'),
        eq(reviewMemoryEntries.status, 'active'),
      ),
    )
}

export const archiveActiveThreadResolvedMemoryForThread = async (params: {
  projectKey: string
  threadId: string
}): Promise<void> => {
  const db = getDb()
  await db
    .update(reviewMemoryEntries)
    .set({
      status: 'archived',
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(reviewMemoryEntries.projectKey, params.projectKey),
        eq(reviewMemoryEntries.threadId, params.threadId),
        eq(reviewMemoryEntries.scope, 'mr'),
        eq(reviewMemoryEntries.status, 'active'),
        eq(reviewMemoryEntries.kind, THREAD_RESOLVED_MEMORY_KIND),
      ),
    )
}

export const listActiveReviewMemory = async (params: {
  projectKey: string
  mrIid?: number | null
}): Promise<ReviewMemoryEntryRecord[]> => {
  const db = getDb()
  const projectScope = and(
    eq(reviewMemoryEntries.scope, 'project'),
    isNull(reviewMemoryEntries.mrIid),
  )
  const scopeFilter =
    params.mrIid != null
      ? or(
          projectScope,
          and(eq(reviewMemoryEntries.scope, 'mr'), eq(reviewMemoryEntries.mrIid, params.mrIid)),
        )
      : projectScope

  return await db
    .select()
    .from(reviewMemoryEntries)
    .where(
      and(
        eq(reviewMemoryEntries.projectKey, params.projectKey),
        eq(reviewMemoryEntries.status, 'active'),
        scopeFilter,
      ),
    )
    .orderBy(desc(reviewMemoryEntries.createdAt))
}

export const createReviewMemoryEvent = async (
  params: CreateReviewMemoryEventParams,
): Promise<ReviewMemoryEventRecord> => {
  const db = getDb()
  const [row] = await db
    .insert(reviewMemoryEvents)
    .values({
      id: crypto.randomUUID(),
      memoryEntryId: params.memoryEntryId ?? null,
      projectKey: params.projectKey,
      mrIid: params.mrIid ?? null,
      threadId: params.threadId ?? null,
      messageId: params.messageId ?? null,
      eventType: params.eventType,
      payload: params.payload ?? null,
    })
    .returning()

  if (!row) {
    throw new Error('Failed to create review memory event')
  }

  return row
}
