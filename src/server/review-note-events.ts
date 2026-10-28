import type { ProjectConfig } from '@/config'
import {
  archiveActiveMemoryForThread,
  createReviewMemoryEntry,
  createReviewMemoryEvent,
} from '@/db/review-memory'
import { getLatestSuccessfulReviewRun, getReviewRun, type ReviewRunRecord } from '@/db/review-runs'
import {
  claimPendingReviewMessage,
  completeReviewMessageProcessing,
  createReviewMessageIfAbsent,
  getReviewMessageByProviderMessageId,
  getReviewThreadByProviderThreadId,
  listReviewMessagesForThread,
  resetReviewMessageProcessing,
  updateReviewThreadStatusByProviderThreadId,
  upsertReviewMessage,
  upsertReviewThread,
  type ReviewMessageRecord,
  type ReviewThreadRecord,
} from '@/db/review-threads'
import { createReviewProvider, type ReviewProvider } from '@/integrations/provider/client'
import type { ProviderThread, ProviderThreadMessage } from '@/integrations/provider/types'
import { postStepOutputSchema } from '@/mastra/review/run-result'
import { buildReviewConversationPlan, mentionsBot } from '@/server/review-conversation'
import { generateThreadReply } from '@/server/review-thread-reply'
import { isNoteAddressedToMend, type IsNoteAddressedToMendParams } from '@/server/note-addressing'
import {
  parseReviewConversationMarker,
  stripAllMendMarkers,
  stripReviewConversationMarker,
} from '@/server/review-conversation-markers'
import { parseMendMarkers } from '@/mastra/review/markers'
import { normalizeReviewMessageBody } from '@/lib/review-threads'
import { parseProviderTimestamp } from '@/lib/timestamps'
import type { ReviewNote } from '@/server/webhook-events'
import {
  markProviderThreadResolved,
  upsertProviderThread,
  persistOutboundReply,
  type ThreadSyncDependencies,
} from '@/server/thread-sync'

let threadSyncDependencyOverrides: Partial<ThreadSyncDependencies> = {}

export const setReviewNoteEventsThreadSyncDependenciesForTest = (
  dependencies: Partial<ThreadSyncDependencies>,
): void => {
  threadSyncDependencyOverrides = dependencies
}

const getThreadSyncDependencies = (): Partial<ThreadSyncDependencies> => ({
  getReviewThreadByProviderThreadId,
  updateReviewThreadStatusByProviderThreadId,
  upsertReviewMessage,
  upsertReviewThread,
  ...threadSyncDependencyOverrides,
})

const findDiscussionForNote = async (
  provider: ReviewProvider,
  mrIid: number,
  noteId: number,
  discussionId?: string,
): Promise<{ thread: ProviderThread; note: ProviderThreadMessage } | null> => {
  if (discussionId) {
    const thread = await provider.getThread(mrIid, discussionId)
    const note = thread.messages.find((candidate) => candidate.id === `${noteId}`)
    if (note) {
      return { thread, note }
    }
    return null
  }

  const threads = await provider.listThreads(mrIid)
  for (const thread of threads) {
    const note = thread.messages.find((candidate) => candidate.id === `${noteId}`)
    if (note) {
      return { thread, note }
    }
  }
  return null
}

const ensureReviewThread = async (params: {
  project: ProjectConfig
  projectKey: string
  mrIid: number
  thread: ProviderThread
  latestReviewRunId: string | null
}): Promise<ReviewThreadRecord> => {
  const existing = await getReviewThreadByProviderThreadId({
    provider: params.project.platform,
    providerThreadId: params.thread.id,
  })

  if (existing) {
    return existing
  }

  const firstNote = params.thread.messages[0]
  const firstNoteRunId = firstNote ? (parseMendMarkers(firstNote.body).runId ?? null) : null

  return await upsertProviderThread({
    project: params.project,
    projectKey: params.projectKey,
    mrIid: params.mrIid,
    thread: params.thread,
    latestReviewRunId: firstNoteRunId ?? params.latestReviewRunId,
    dependencies: getThreadSyncDependencies(),
  })
}

const refreshExistingThreadFromDiscussion = async (params: {
  thread: ReviewThreadRecord
  providerThread: ProviderThread
}): Promise<ReviewThreadRecord> => {
  const firstNote = params.providerThread.messages[0]
  const firstNoteRunId = firstNote ? (parseMendMarkers(firstNote.body).runId ?? null) : null

  return await upsertProviderThread({
    project: {
      key: params.thread.projectKey,
      platform: params.thread.provider,
    } as ProjectConfig,
    projectKey: params.thread.projectKey,
    mrIid: params.thread.reviewExternalId,
    thread: params.providerThread,
    latestReviewRunId: firstNoteRunId ?? params.thread.reviewRunId,
    existingThread: params.thread,
    dependencies: getThreadSyncDependencies(),
  })
}

const addReaction = async (params: {
  provider: ReviewProvider
  mrIid: number
  noteId: number
  name: string
  hasThreadContext: boolean
}): Promise<void> => {
  try {
    if (params.hasThreadContext) {
      await params.provider.addThreadMessageReaction(params.mrIid, params.noteId, params.name)
    } else {
      await params.provider.addNoteReaction(params.mrIid, params.noteId, params.name)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('has already been taken')) {
      return
    }
    throw error
  }
}

interface ReviewRunContext {
  assessment: 'approve' | 'request_changes' | 'needs_discussion' | null
  summary: string | null
  findingsCount: number
  inlineCommentCount: number
  reviewRunId: string
  sourceBranch: string | null
  commitSha: string | null
}

const buildReviewRunContext = (reviewRun: ReviewRunRecord): ReviewRunContext => {
  const input = reviewRun.input as Record<string, unknown> | null
  const sourceBranch = typeof input?.sourceBranch === 'string' ? input.sourceBranch : null
  const commitSha = reviewRun.commitSha ?? null

  const parsed = reviewRun.result ? postStepOutputSchema.safeParse(reviewRun.result) : null
  if (!parsed?.success) {
    return {
      assessment: null,
      summary: null,
      findingsCount: 0,
      inlineCommentCount: 0,
      reviewRunId: reviewRun.id,
      sourceBranch,
      commitSha,
    }
  }

  return {
    assessment: parsed.data.assessment,
    summary: parsed.data.summary,
    findingsCount: parsed.data.findings.length,
    inlineCommentCount: parsed.data.inlineComments.length,
    reviewRunId: parsed.data.reviewRunId,
    sourceBranch,
    commitSha,
  }
}

const buildLatestReviewContext = async (projectKey: string, mrIid: number) => {
  const latestRun = await getLatestSuccessfulReviewRun({ projectKey, mrIid })
  if (!latestRun) {
    return null
  }

  return buildReviewRunContext(latestRun)
}

const buildThreadReplyReviewContext = async (
  thread: ReviewThreadRecord,
): Promise<ReviewRunContext | null> => {
  if (thread.reviewRunId) {
    const reviewRun = await getReviewRun(thread.reviewRunId)
    if (reviewRun) {
      return buildReviewRunContext(reviewRun)
    }

    return null
  }

  return await buildLatestReviewContext(thread.projectKey, thread.reviewExternalId)
}

const canPersistMemory = (params: {
  thread: ReviewThreadRecord
  planMemory: NonNullable<ReturnType<typeof buildReviewConversationPlan>['memory']>
}): boolean => {
  if (params.planMemory.scope === 'project') {
    return params.planMemory.matchCategory !== null && params.planMemory.matchCategory !== undefined
  }

  return true
}

const normalizeForIdempotencyCheck = (body: string): string =>
  normalizeReviewMessageBody(stripReviewConversationMarker(body))

const THREAD_REPLY_CONTEXT_UNAVAILABLE =
  'I saw your question, but I could not load the exact reviewed code context for this thread right now. Please try again after the next review run or ask a broader question in the merge request.'

const hasExistingLocalReply = (threadMessages: ReviewMessageRecord[], body: string): boolean =>
  threadMessages.some(
    (message) =>
      message.authorType === 'agent' &&
      message.direction === 'outbound' &&
      normalizeForIdempotencyCheck(message.body) === normalizeForIdempotencyCheck(body),
  )

export type { IsNoteAddressedToMendParams }
export { isNoteAddressedToMend }

export const processReviewNoteEvent = async (params: {
  project: ProjectConfig
  note: ReviewNote
  rawPayload: unknown
}): Promise<void> => {
  const { project, note } = params
  if (project.review.flags.dry_run) {
    console.log(
      `[notes] dry run: ignoring note ${note.noteId} on ${project.key} MR !${note.mrIid} without provider writes`,
    )
    return
  }
  const provider = createReviewProvider(project)

  const currentUser = await provider.fetchCurrentUser()
  if (note.author.id === currentUser.id) {
    return
  }

  const { mrIid, noteId } = note
  const webhookDiscussionId = note.discussionId
  const hasThreadContext = webhookDiscussionId !== undefined || note.isDiffNote
  const directMention = mentionsBot(note.body, currentUser.username)

  let discussionId: string
  let discussion: ProviderThread | null = null
  let existingThread: ReviewThreadRecord | null = null
  let threadMessages: ReviewMessageRecord[]

  if (webhookDiscussionId) {
    existingThread = await getReviewThreadByProviderThreadId({
      provider: project.platform,
      providerThreadId: webhookDiscussionId,
    })
  }

  if (existingThread) {
    discussionId = webhookDiscussionId ?? existingThread.providerThreadId
    threadMessages = await listReviewMessagesForThread(existingThread.id)

    const needsDiscussionContext =
      !existingThread.reviewRunId ||
      !threadMessages.some(
        (message) => message.authorType === 'agent' && message.direction === 'outbound',
      )

    if (needsDiscussionContext) {
      const result = await findDiscussionForNote(provider, mrIid, noteId, webhookDiscussionId)
      if (result) {
        discussion = result.thread
        discussionId = discussion.id
        existingThread = await refreshExistingThreadFromDiscussion({
          thread: existingThread,
          providerThread: discussion,
        })
      }
    }
  } else {
    const result = await findDiscussionForNote(provider, mrIid, noteId, webhookDiscussionId)
    if (!result) {
      if (directMention) {
        throw new Error(`Unable to locate discussion for MR !${mrIid} note ${noteId}`)
      }
      return
    }
    discussion = result.thread
    discussionId = discussion.id

    existingThread = await getReviewThreadByProviderThreadId({
      provider: project.platform,
      providerThreadId: discussionId,
    })
    threadMessages = existingThread ? await listReviewMessagesForThread(existingThread.id) : []
  }

  const lastMessage = threadMessages[threadMessages.length - 1] ?? null
  const firstDiscussionNoteAuthorId = discussion?.messages[0]?.author.id ?? null

  const addressedToMend = isNoteAddressedToMend({
    directMention,
    existingMendThread: !!existingThread,
    lastExistingMessage: lastMessage
      ? { authorType: lastMessage.authorType, processingStatus: lastMessage.processingStatus }
      : null,
    existingThreadMessageCount: threadMessages.length,
    firstDiscussionNoteAuthorId,
    currentUserId: currentUser.id,
  })
  if (!addressedToMend) {
    return
  }

  const latestReview = await buildLatestReviewContext(project.key, mrIid)
  let thread = existingThread
  if (!thread) {
    if (!discussion) {
      throw new Error(`Unable to locate discussion for MR !${mrIid} note ${noteId}`)
    }

    thread = await ensureReviewThread({
      project,
      projectKey: project.key,
      mrIid,
      thread: discussion,
      latestReviewRunId: latestReview?.reviewRunId ?? null,
    })
  }

  if (!existingThread) {
    threadMessages = await listReviewMessagesForThread(thread.id)
  }

  const createdMessage = await createReviewMessageIfAbsent({
    threadId: thread.id,
    provider: project.platform,
    reviewRunId: thread.reviewRunId ?? latestReview?.reviewRunId ?? null,
    authorType: 'human',
    authorExternalId: `${note.author.id}`,
    authorName: note.author.username,
    direction: 'inbound',
    body: note.body,
    providerMessageId: `${noteId}`,
    providerParentMessageId: null,
    providerUrl: note.url ?? null,
    rawProviderData: params.rawPayload,
    providerCreatedAt: parseProviderTimestamp(note.createdAt),
    providerUpdatedAt: parseProviderTimestamp(note.updatedAt),
  })

  let inboundMessage = createdMessage

  if (!inboundMessage) {
    const existingMessage = await getReviewMessageByProviderMessageId({
      provider: project.platform,
      providerMessageId: `${noteId}`,
    })

    if (!existingMessage || existingMessage.direction !== 'inbound') {
      return
    }

    const claimed = await claimPendingReviewMessage(existingMessage.id)
    if (!claimed) {
      return
    }

    inboundMessage = existingMessage
  }

  try {
    await addReaction({
      provider,
      mrIid,
      noteId,
      name: 'eyes',
      hasThreadContext,
    }).catch((error) => {
      console.warn(`[notes] failed to add eyes reaction to note ${noteId}: ${error}`)
    })

    const lastAgentMessage = [...threadMessages]
      .reverse()
      .find((message) => message.authorType === 'agent')
    const pendingMarker = lastAgentMessage
      ? parseReviewConversationMarker(lastAgentMessage.body)
      : null
    const originalAgentMessage = threadMessages.find(
      (message) => message.authorType === 'agent' && message.direction === 'outbound',
    )
    const originalDiscussionNote =
      discussion?.messages[0]?.author.id === currentUser.id ? discussion.messages[0] : null
    const originalAgentBodyText = originalAgentMessage
      ? stripAllMendMarkers(originalAgentMessage.body)
      : originalDiscussionNote
        ? stripAllMendMarkers(originalDiscussionNote.body)
        : null

    const plan = buildReviewConversationPlan({
      noteBody: note.body,
      botUsername: currentUser.username,
      trustedForProjectMemory: project.review.memory.project_scope_usernames.includes(
        note.author.username,
      ),
      pendingMarker,
      thread: {
        path: thread.path,
        line: thread.line,
        originalAgentBody: originalAgentBodyText,
      },
      latestReview:
        latestReview?.assessment && latestReview?.summary
          ? {
              assessment: latestReview.assessment,
              summary: latestReview.summary,
              findingsCount: latestReview.findingsCount,
              inlineCommentCount: latestReview.inlineCommentCount,
            }
          : null,
    })

    if (!plan.relevant) {
      await createReviewMemoryEvent({
        projectKey: project.key,
        mrIid,
        threadId: thread.id,
        messageId: inboundMessage.id,
        eventType: 'ignored',
        payload: { reason: 'not actionable' },
      })
      await completeReviewMessageProcessing(inboundMessage.id)
      return
    }

    let memoryEntryId: string | null = null
    let replyBody = plan.replyBody
    let addSuccessReaction = plan.addSuccessReaction
    let resolveThread = plan.resolveThread
    let replyReviewRunId = latestReview?.reviewRunId ?? null

    if (plan.requiresLlmReply) {
      try {
        const replyReviewContext = await buildThreadReplyReviewContext(thread)
        if (!replyReviewContext?.sourceBranch) {
          replyBody = THREAD_REPLY_CONTEXT_UNAVAILABLE
          addSuccessReaction = false
        } else {
          replyReviewRunId = replyReviewContext.reviewRunId
          const allMessages = [...threadMessages]
          if (!allMessages.some((m) => m.providerMessageId === `${noteId}`)) {
            allMessages.push(inboundMessage)
          }

          const threadHistory = allMessages.map((m) => ({
            author: m.authorName ?? 'unknown',
            body: stripAllMendMarkers(m.body),
          }))

          replyBody = await generateThreadReply({
            project,
            mrIid,
            requestId: `note-${noteId}`,
            sourceBranch: replyReviewContext.sourceBranch,
            commitSha: replyReviewContext.commitSha,
            filePath: thread.path,
            line: thread.line,
            originalFinding: originalAgentBodyText ?? '',
            threadMessages: threadHistory,
            userQuestion: stripAllMendMarkers(note.body),
          })
        }
      } catch (error) {
        console.error(`[notes] LLM thread reply failed for MR !${mrIid}: ${error}`)
        replyBody =
          "I wasn't able to generate a detailed response right now. Please try again or rephrase your question."
        addSuccessReaction = false
      }
    }

    if (plan.memory) {
      if (!canPersistMemory({ thread, planMemory: plan.memory })) {
        replyBody =
          'I understood the feedback, but I can only remember it reliably for a specific inline finding or a known project-wide rule like testing right now.'
        addSuccessReaction = false
        resolveThread = false
      } else {
        if (plan.memory.scope === 'mr') {
          await archiveActiveMemoryForThread({
            projectKey: project.key,
            threadId: thread.id,
          })
        }

        const memoryEntry = await createReviewMemoryEntry({
          scope: plan.memory.scope,
          projectKey: project.key,
          mrIid: plan.memory.scope === 'mr' ? mrIid : null,
          threadId: thread.id,
          sourceMessageId: inboundMessage.id,
          kind: plan.memory.kind,
          instruction: plan.memory.instruction,
          matchFingerprint: thread.findingFingerprint,
          matchPath: thread.path,
          matchLine: thread.line,
          matchCategory: plan.memory.matchCategory ?? null,
          metadata: {
            ...(plan.memory.metadata ?? {}),
            sourceBody: originalAgentBodyText ?? stripAllMendMarkers(note.body),
          },
          createdByExternalId: `${note.author.id}`,
          createdByName: note.author.username,
        })
        memoryEntryId = memoryEntry.id
        await createReviewMemoryEvent({
          memoryEntryId,
          projectKey: project.key,
          mrIid,
          threadId: thread.id,
          messageId: inboundMessage.id,
          eventType: 'created',
          payload: { scope: plan.memory.scope, kind: plan.memory.kind },
        })
      }
    }

    if (replyBody) {
      if (!hasExistingLocalReply(threadMessages, replyBody)) {
        const reply = await provider.replyToThread(mrIid, discussionId, replyBody)
        const replyMessage = await persistOutboundReply({
          thread,
          reviewRunId: replyReviewRunId,
          reply,
          dependencies: getThreadSyncDependencies(),
        })
        await createReviewMemoryEvent({
          memoryEntryId,
          projectKey: project.key,
          mrIid,
          threadId: thread.id,
          messageId: replyMessage.id,
          eventType: memoryEntryId ? 'confirmed' : 'replied',
          payload: { replyType: memoryEntryId ? 'memory' : 'conversation' },
        })
      }
    }

    if (
      resolveThread &&
      (thread.threadKind === 'inline' || thread.threadKind === 'summary_finding') &&
      thread.status !== 'resolved'
    ) {
      const providerResolved = await provider.resolveThread(mrIid, discussionId)
      if (providerResolved) {
        await markProviderThreadResolved({
          provider: provider.kind,
          providerThreadId: discussionId,
          dependencies: getThreadSyncDependencies(),
        })
      }
    }

    if (addSuccessReaction) {
      await addReaction({
        provider,
        mrIid,
        noteId,
        name: 'white_check_mark',
        hasThreadContext,
      }).catch((error) => {
        console.warn(`[notes] failed to add success reaction to note ${noteId}: ${error}`)
      })
    }

    await completeReviewMessageProcessing(inboundMessage.id)
  } catch (error) {
    await resetReviewMessageProcessing(inboundMessage.id)
    throw error
  }
}
