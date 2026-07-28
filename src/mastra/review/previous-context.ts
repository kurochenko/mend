import type { ProjectConfig } from '@/config'
import {
  archiveActiveThreadResolvedMemoryForThread,
  createReviewMemoryEntry,
  THREAD_RESOLVED_MEMORY_KIND,
} from '@/db/review-memory'
import {
  getReviewMessageByProviderMessageId,
  listReviewThreadsForMr,
  listReviewThreadsForRun,
  updateReviewThreadStatusByProviderThreadId,
  upsertReviewMessage,
  type ReviewThreadRecord,
} from '@/db/review-threads'
import { getReviewRun } from '@/db/review-runs'
import { createReviewProvider } from '@/integrations/provider/client'
import type { ProviderThread } from '@/integrations/provider/types'
import type { ExistingPublishedThread } from '@/mastra/review/publish-plan'
import { postStepOutputSchema } from '@/mastra/review/run-result'
import {
  collectPersistableThreads,
  findLatestHumanReply,
  getThreadStatus,
  type PersistableThread,
} from '@/mastra/review/thread-context'
import { parseProviderTimestamp } from '@/lib/timestamps'

export interface PreviousFinding {
  id: string
  category: string
  severity: string
  title: string
  body: string
  files: string[]
  discussionId: string | null
  resolved: boolean
}

export interface PreviousInlineComment {
  file: string
  line: number
  severity: 'bug' | 'security' | 'performance' | 'suggestion'
  body: string
  discussionId: string | null
  resolved: boolean
}

export interface PreviousReviewContext {
  previousRunId: string
  previousCommitSha: string | null
  previousAssessment: string
  findings: PreviousFinding[]
  inlineComments: PreviousInlineComment[]
}

const isPublishedFindingThreadKind = (threadKind: string): boolean =>
  threadKind === 'inline' || threadKind === 'summary_finding'

const syncResolvedThreadMemory = async (params: {
  projectKey: string
  platform: ProjectConfig['platform']
  mrIid: number
  storedThread: ReviewThreadRecord
  entry: PersistableThread
  status: ExistingPublishedThread['status']
}): Promise<void> => {
  if (params.status === 'open') {
    await archiveActiveThreadResolvedMemoryForThread({
      projectKey: params.projectKey,
      threadId: params.storedThread.id,
    })
    return
  }

  const humanReply = findLatestHumanReply(params.entry.thread)
  if (!humanReply) {
    return
  }

  const sourceMessage =
    (await getReviewMessageByProviderMessageId({
      provider: params.platform,
      providerMessageId: humanReply.id,
    })) ??
    (await upsertReviewMessage({
      threadId: params.storedThread.id,
      provider: params.platform,
      reviewRunId: params.storedThread.reviewRunId,
      authorType: 'human',
      authorExternalId: `${humanReply.author.id}`,
      authorName: humanReply.author.username,
      direction: 'inbound',
      body: humanReply.body,
      providerMessageId: humanReply.id,
      providerParentMessageId: params.entry.firstNote.id,
      providerUrl: humanReply.url ?? null,
      rawProviderData: humanReply.raw,
      providerCreatedAt: parseProviderTimestamp(humanReply.createdAt),
      providerUpdatedAt: parseProviderTimestamp(humanReply.updatedAt),
    }))

  await createReviewMemoryEntry({
    scope: 'mr',
    projectKey: params.projectKey,
    mrIid: params.mrIid,
    threadId: params.storedThread.id,
    sourceMessageId: sourceMessage.id,
    kind: THREAD_RESOLVED_MEMORY_KIND,
    instruction: `This concern was raised previously and ${humanReply.author.username} resolved the thread with a reply. Treat the decision as settled and do not re-raise the same concern, even if the code moved to another file or line.`,
    matchFingerprint: params.storedThread.findingFingerprint,
    matchPath: params.storedThread.path,
    matchLine: params.storedThread.line,
    metadata: {
      sourceBody: params.entry.firstNote.body,
      humanReplyBody: humanReply.body,
      humanReplyNoteId: humanReply.id,
    },
    createdByExternalId: `${humanReply.author.id}`,
    createdByName: humanReply.author.username,
  })
}

export const loadPublishedReviewThreadsForMr = async (params: {
  project: ProjectConfig
  projectKey: string
  mrIid: number
}): Promise<ExistingPublishedThread[]> => {
  const byFingerprint = new Map<string, ExistingPublishedThread>()
  const storedThreads = await listReviewThreadsForMr({
    projectKey: params.projectKey,
    mrIid: params.mrIid,
  })
  const storedThreadsByProviderThreadId = new Map(
    storedThreads.map((thread) => [thread.providerThreadId, thread] as const),
  )

  for (const thread of storedThreads) {
    if (
      thread.status === 'archived' ||
      !isPublishedFindingThreadKind(thread.threadKind) ||
      !thread.findingFingerprint
    ) {
      continue
    }

    byFingerprint.set(thread.findingFingerprint, {
      findingFingerprint: thread.findingFingerprint,
      status: thread.status === 'resolved' ? 'resolved' : 'open',
    })
  }

  try {
    const provider = createReviewProvider(params.project)
    const threads = await provider.listThreads(params.mrIid)
    for (const entry of collectPersistableThreads(threads)) {
      const storedThread = storedThreadsByProviderThreadId.get(entry.thread.id)
      if (storedThread?.status === 'archived') {
        continue
      }

      if (
        !isPublishedFindingThreadKind(entry.context.threadKind) ||
        !entry.context.findingFingerprint
      ) {
        continue
      }

      const status = getThreadStatus(entry.thread)
      byFingerprint.set(entry.context.findingFingerprint, {
        findingFingerprint: entry.context.findingFingerprint,
        status,
      })

      await updateReviewThreadStatusByProviderThreadId({
        provider: params.project.platform,
        providerThreadId: entry.thread.id,
        status,
      })

      if (storedThread) {
        try {
          await syncResolvedThreadMemory({
            projectKey: params.projectKey,
            platform: params.project.platform,
            mrIid: params.mrIid,
            storedThread,
            entry,
            status,
          })
        } catch (error) {
          console.warn(
            `[previous-context] failed to sync resolved-thread memory for ${params.projectKey} MR !${params.mrIid} discussion ${entry.thread.id}: ${error}`,
          )
        }
      }
    }
  } catch (error) {
    console.warn(
      `[previous-context] failed to load live published threads for ${params.projectKey} MR !${params.mrIid}: ${error}`,
    )
  }

  return [...byFingerprint.values()]
}

const buildInlineCommentKey = (comment: { file: string; line: number; body: string }): string =>
  `${comment.file}:${comment.line}:${comment.body}`

const loadStoredThreadStatus = async (params: {
  previousRunId: string
  platform: ProjectConfig['platform']
}): Promise<Map<string, boolean>> => {
  const threads = await listReviewThreadsForRun(params.previousRunId)
  return new Map(
    threads
      .filter(
        (thread) =>
          (thread.threadKind === 'inline' || thread.threadKind === 'summary_finding') &&
          thread.provider === params.platform,
      )
      .map((thread) => [thread.providerThreadId, thread.status === 'resolved'] as const),
  )
}

const formatFindingStatus = (params: {
  discussionId: string | null
  discussionIdToStatus: Map<string, boolean>
}): { discussionId: string | null; resolved: boolean } => {
  if (!params.discussionId) {
    return {
      discussionId: null,
      resolved: false,
    }
  }

  return {
    discussionId: params.discussionId,
    resolved: params.discussionIdToStatus.get(params.discussionId) ?? false,
  }
}

const isThreadResolved = (thread: ProviderThread): boolean => {
  const firstNote = thread.messages[0]
  if (!firstNote?.resolvable) {
    return false
  }

  return firstNote.resolved === true
}

const refreshThreadStatus = async (params: {
  project: ProjectConfig
  mrIid: number
  discussionIds: string[]
  storedThreadStatus: Map<string, boolean>
}): Promise<Map<string, boolean>> => {
  if (params.discussionIds.length === 0) {
    return params.storedThreadStatus
  }

  const provider = createReviewProvider(params.project)
  const threads = await provider.listThreads(params.mrIid)
  const discussionIds = new Set(params.discussionIds)
  const refreshedThreadStatus = new Map(params.storedThreadStatus)

  for (const thread of threads) {
    if (!discussionIds.has(thread.id)) {
      continue
    }

    const resolved = isThreadResolved(thread)
    refreshedThreadStatus.set(thread.id, resolved)

    await updateReviewThreadStatusByProviderThreadId({
      provider: params.project.platform,
      providerThreadId: thread.id,
      status: resolved ? 'resolved' : 'open',
    })
  }

  return refreshedThreadStatus
}

export const buildPreviousReviewContext = async (params: {
  project: ProjectConfig
  mrIid: number
  previousRunId: string
}): Promise<PreviousReviewContext | null> => {
  const run = await getReviewRun(params.previousRunId)
  if (!run || !run.result) {
    return null
  }

  const parsed = postStepOutputSchema.safeParse(run.result)
  if (!parsed.success) {
    console.warn(
      `[previous-context] failed to parse result for run ${params.previousRunId}: ${parsed.error.message}`,
    )
    return null
  }

  const result = parsed.data

  const discussionIds = [
    ...result.postedInlineComments,
    ...result.postedFindings,
    ...result.threadedFindings,
    ...result.threadedInlineComments,
  ]
    .map((comment) => comment.providerThreadId)
    .filter((discussionId): discussionId is string => discussionId !== null)

  let threadStatus = await loadStoredThreadStatus({
    previousRunId: params.previousRunId,
    platform: params.project.platform,
  })

  if (discussionIds.length > 0) {
    try {
      threadStatus = await refreshThreadStatus({
        project: params.project,
        mrIid: params.mrIid,
        discussionIds,
        storedThreadStatus: threadStatus,
      })
    } catch (error) {
      console.warn(
        `[previous-context] failed to refresh thread status for run ${params.previousRunId}: ${error}`,
      )
    }
  }

  const findings: PreviousFinding[] = result.findings.map((finding, index) => {
    const status = formatFindingStatus({
      discussionId: result.postedFindings[index]?.providerThreadId ?? null,
      discussionIdToStatus: threadStatus,
    })

    return {
      id: finding.id,
      category: finding.category,
      severity: finding.severity,
      title: finding.title,
      body: finding.body,
      files: finding.files ?? [],
      discussionId: status.discussionId,
      resolved: status.resolved,
    }
  })

  const threadedFindings = result.threadedFindings
    .filter((finding) => !findings.some((existing) => existing.id === finding.id))
    .map((finding) => {
      const status = formatFindingStatus({
        discussionId: finding.providerThreadId,
        discussionIdToStatus: threadStatus,
      })

      return {
        id: finding.id,
        category: finding.category,
        severity: finding.severity,
        title: finding.title,
        body: finding.body,
        files: finding.files ?? [],
        discussionId: status.discussionId,
        resolved: status.resolved,
      }
    })

  const inlineComments: PreviousInlineComment[] = result.inlineComments.map((comment, index) => {
    const postedInlineComment = result.postedInlineComments[index]
    const discussionId = postedInlineComment?.providerThreadId ?? null

    return {
      file: comment.file,
      line: comment.line,
      severity: comment.severity,
      body: comment.body,
      discussionId,
      resolved: discussionId ? (threadStatus.get(discussionId) ?? false) : false,
    }
  })

  const threadedInlineComments = result.threadedInlineComments
    .filter(
      (comment) =>
        !inlineComments.some(
          (existing) => buildInlineCommentKey(existing) === buildInlineCommentKey(comment),
        ),
    )
    .map((comment) => ({
      file: comment.file,
      line: comment.line,
      severity: comment.severity,
      body: comment.body,
      discussionId: comment.providerThreadId,
      resolved: comment.providerThreadId
        ? (threadStatus.get(comment.providerThreadId) ?? false)
        : false,
    }))

  return {
    previousRunId: params.previousRunId,
    previousCommitSha: run.commitSha,
    previousAssessment: result.assessment,
    findings: [...findings, ...threadedFindings],
    inlineComments: [...inlineComments, ...threadedInlineComments],
  }
}
