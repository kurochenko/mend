import type { ProjectConfig } from '@/config'
import {
  getReviewFindingByProviderThreadId,
  updateReviewFindingState,
  upsertReviewFinding,
  type ReviewFindingRecord,
} from '@/db/review-findings'
import {
  getReviewThreadByProviderThreadId,
  updateReviewThreadStatusByProviderThreadId,
  upsertReviewMessage,
  upsertReviewThread,
  type ReviewMessageRecord,
  type ReviewThreadRecord,
} from '@/db/review-threads'
import type { ProviderThread, ProviderThreadMessage } from '@/integrations/provider/types'
import {
  collectPersistableThreads,
  deriveThreadContext,
  getThreadStatus,
} from '@/mastra/review/thread-context'
import { parseProviderTimestamp } from '@/lib/timestamps'

export interface ThreadSyncDependencies {
  getReviewThreadByProviderThreadId: typeof getReviewThreadByProviderThreadId
  updateReviewThreadStatusByProviderThreadId: typeof updateReviewThreadStatusByProviderThreadId
  upsertReviewMessage: typeof upsertReviewMessage
  upsertReviewThread: typeof upsertReviewThread
  getReviewFindingByProviderThreadId: typeof getReviewFindingByProviderThreadId
  updateReviewFindingState: typeof updateReviewFindingState
  upsertReviewFinding: typeof upsertReviewFinding
}

const defaultDependencies: ThreadSyncDependencies = {
  getReviewThreadByProviderThreadId,
  updateReviewThreadStatusByProviderThreadId,
  upsertReviewMessage,
  upsertReviewThread,
  getReviewFindingByProviderThreadId,
  updateReviewFindingState,
  upsertReviewFinding,
}

export const buildResolvedFindingStateUpdate = (
  reply: ProviderThreadMessage,
): {
  state: 'resolved'
  decisionReason: string
  decidedByExternalId: string
  decidedByName: string
} => ({
  state: 'resolved',
  decisionReason: reply.body,
  decidedByExternalId: `${reply.author.id}`,
  decidedByName: reply.author.username,
})

export const upsertProviderThread = async (params: {
  project: ProjectConfig
  projectKey: string
  mrIid: number
  thread: ProviderThread
  latestReviewRunId?: string | null
  existingThread?: ReviewThreadRecord | null
  dependencies?: Partial<ThreadSyncDependencies>
}): Promise<ReviewThreadRecord> => {
  const dependencies = { ...defaultDependencies, ...params.dependencies }
  const existing =
    params.existingThread ??
    (await dependencies.getReviewThreadByProviderThreadId({
      provider: 'gitlab',
      providerThreadId: params.thread.id,
    }))

  const firstNote = params.thread.messages[0]
  const context = deriveThreadContext(params.thread)
  const reviewRunId = firstNote
    ? (collectPersistableThreads([params.thread])[0]?.firstNoteRunId ?? null)
    : null

  return await dependencies.upsertReviewThread({
    provider: 'gitlab',
    projectKey: existing?.projectKey ?? params.projectKey,
    repoExternalId: existing?.repoExternalId ?? `${params.project.project_id}`,
    reviewExternalId: existing?.reviewExternalId ?? params.mrIid,
    reviewRunId: reviewRunId ?? existing?.reviewRunId ?? params.latestReviewRunId ?? null,
    threadKind: context.threadKind,
    subjectType: context.subjectType,
    path: context.path,
    line: context.line,
    findingFingerprint: context.findingFingerprint,
    status: firstNote?.resolved ? 'resolved' : 'open',
    providerThreadId: existing?.providerThreadId ?? params.thread.id,
    providerUrl: firstNote?.url ?? existing?.providerUrl ?? null,
    rawProviderData: params.thread.raw,
    providerCreatedAt: parseProviderTimestamp(firstNote?.createdAt),
    providerUpdatedAt: parseProviderTimestamp(firstNote?.updatedAt),
  })
}

export const persistOutboundReply = async (params: {
  thread: ReviewThreadRecord
  reviewRunId: string | null
  reply: ProviderThreadMessage
  dependencies?: Partial<ThreadSyncDependencies>
}): Promise<ReviewMessageRecord> => {
  const dependencies = { ...defaultDependencies, ...params.dependencies }
  return await dependencies.upsertReviewMessage({
    threadId: params.thread.id,
    provider: 'gitlab',
    reviewRunId: params.reviewRunId,
    authorType: 'agent',
    authorExternalId: `${params.reply.author.id}`,
    authorName: params.reply.author.username,
    direction: 'outbound',
    body: params.reply.body,
    providerMessageId: params.reply.id,
    providerParentMessageId: null,
    providerUrl: params.reply.url ?? null,
    rawProviderData: params.reply.raw,
    providerCreatedAt: parseProviderTimestamp(params.reply.createdAt),
    providerUpdatedAt: parseProviderTimestamp(params.reply.updatedAt),
  })
}

export const persistProviderReplyLocally = async (params: {
  threadId: string
  reviewRunId: string | null
  reply: ProviderThreadMessage
  markResolved: boolean
  dependencies?: Partial<ThreadSyncDependencies>
}): Promise<void> => {
  const dependencies = { ...defaultDependencies, ...params.dependencies }
  const thread = await dependencies.getReviewThreadByProviderThreadId({
    provider: 'gitlab',
    providerThreadId: params.threadId,
  })

  if (!thread) {
    return
  }

  await persistOutboundReply({
    thread,
    reviewRunId: params.reviewRunId,
    reply: params.reply,
    dependencies,
  })

  if (!params.markResolved) {
    return
  }

  await dependencies.updateReviewThreadStatusByProviderThreadId({
    provider: 'gitlab',
    providerThreadId: params.threadId,
    status: 'resolved',
  })

  const finding = await dependencies.getReviewFindingByProviderThreadId({
    provider: 'gitlab',
    providerThreadId: params.threadId,
  })

  if (!finding) {
    return
  }

  await dependencies.updateReviewFindingState({
    id: finding.id,
    ...buildResolvedFindingStateUpdate(params.reply),
  })
}

export const markProviderThreadResolved = async (params: {
  providerThreadId: string
  dependencies?: Partial<ThreadSyncDependencies>
}): Promise<void> => {
  const dependencies = { ...defaultDependencies, ...params.dependencies }
  await dependencies.updateReviewThreadStatusByProviderThreadId({
    provider: 'gitlab',
    providerThreadId: params.providerThreadId,
    status: 'resolved',
  })
}

export const persistPublishedThreads = async (params: {
  project: ProjectConfig
  projectKey: string
  mrIid: number
  reviewRunId: string
  threads: ProviderThread[]
  dependencies?: Partial<ThreadSyncDependencies>
}): Promise<{
  summaryNoteId: number | null
  inlineComments: Array<{
    findingFingerprint: string
    providerThreadId: string
    providerMessageId: string
  }>
  summaryFindings: Array<{
    findingFingerprint: string
    providerThreadId: string
    providerMessageId: string
  }>
}> => {
  const dependencies = { ...defaultDependencies, ...params.dependencies }
  const persistable = collectPersistableThreads(params.threads, params.reviewRunId)
  let summaryNoteId: number | null = null
  const inlineComments: Array<{
    findingFingerprint: string
    providerThreadId: string
    providerMessageId: string
  }> = []
  const summaryFindings: Array<{
    findingFingerprint: string
    providerThreadId: string
    providerMessageId: string
  }> = []

  for (const entry of persistable) {
    const thread = await dependencies.upsertReviewThread({
      provider: 'gitlab',
      projectKey: params.projectKey,
      repoExternalId: `${params.project.project_id}`,
      reviewExternalId: params.mrIid,
      reviewRunId: params.reviewRunId,
      threadKind: entry.context.threadKind,
      subjectType: entry.context.subjectType,
      path: entry.context.path,
      line: entry.context.line,
      findingFingerprint: entry.context.findingFingerprint,
      status: getThreadStatus(entry.thread),
      providerThreadId: entry.thread.id,
      providerUrl: entry.firstNote.url ?? null,
      rawProviderData: entry.thread.raw,
      providerCreatedAt: parseProviderTimestamp(entry.firstNote.createdAt),
      providerUpdatedAt: parseProviderTimestamp(entry.firstNote.updatedAt),
    })

    await dependencies.upsertReviewMessage({
      threadId: thread.id,
      provider: 'gitlab',
      reviewRunId: params.reviewRunId,
      authorType: 'agent',
      authorExternalId: `${entry.firstNote.author.id}`,
      authorName: entry.firstNote.author.username,
      direction: 'outbound',
      body: entry.firstNote.body,
      providerMessageId: entry.firstNote.id,
      providerUrl: entry.firstNote.url ?? null,
      rawProviderData: entry.firstNote.raw,
      providerCreatedAt: parseProviderTimestamp(entry.firstNote.createdAt),
      providerUpdatedAt: parseProviderTimestamp(entry.firstNote.updatedAt),
    })

    if (entry.context.threadKind === 'summary_note') {
      summaryNoteId = Number(entry.firstNote.id)
      continue
    }

    if (entry.context.threadKind === 'inline' && entry.context.findingFingerprint) {
      inlineComments.push({
        findingFingerprint: entry.context.findingFingerprint,
        providerThreadId: entry.thread.id,
        providerMessageId: entry.firstNote.id,
      })
      continue
    }

    if (entry.context.threadKind === 'summary_finding' && entry.context.findingFingerprint) {
      summaryFindings.push({
        findingFingerprint: entry.context.findingFingerprint,
        providerThreadId: entry.thread.id,
        providerMessageId: entry.firstNote.id,
      })
    }
  }

  return { summaryNoteId, inlineComments, summaryFindings }
}

export const persistPostedReviewFindings = async (params: {
  projectKey: string
  mrIid: number
  reviewRunId: string
  findings: Array<{
    ref: { providerThreadId: string | null; providerMessageId: string | null }
    metadata: unknown
  }>
  dependencies?: Partial<ThreadSyncDependencies>
}): Promise<ReviewFindingRecord[]> => {
  const dependencies = { ...defaultDependencies, ...params.dependencies }
  const persisted: ReviewFindingRecord[] = []

  for (const finding of params.findings) {
    if (!finding.ref.providerThreadId) {
      continue
    }

    const thread = await dependencies.getReviewThreadByProviderThreadId({
      provider: 'gitlab',
      providerThreadId: finding.ref.providerThreadId,
    })

    if (!thread) {
      continue
    }

    persisted.push(
      await dependencies.upsertReviewFinding({
        projectKey: params.projectKey,
        mrIid: params.mrIid,
        reviewRunId: params.reviewRunId,
        threadId: thread.id,
        provider: 'gitlab',
        providerThreadId: finding.ref.providerThreadId,
        providerNoteId: finding.ref.providerMessageId,
        metadata: finding.metadata,
      }),
    )
  }

  return persisted
}
