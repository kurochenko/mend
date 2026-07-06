import type { ProjectConfig } from '@/config'
import type { Mastra } from '@mastra/core'
import { getReviewFindingByThreadId, updateReviewFindingState } from '@/db/review-findings'
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
import { requestAcceptedFixBatch } from '@/server/fix-batch-queue'
import { ensureFixBatchRunner } from '@/server/fix-batch-runner'
import { enqueueMrReview } from '@/server/mr-review-queue'
import { generateThreadReply } from '@/server/review-thread-reply'
import { parseReviewTriageCommand, type ReviewTriageCommand } from '@/server/review-triage-commands'
import { isNoteAddressedToMend, type IsNoteAddressedToMendParams } from '@/server/note-addressing'
import {
  parseReviewConversationMarker,
  stripAllMendMarkers,
  stripReviewConversationMarker,
} from '@/server/review-conversation-markers'
import { parseMendMarkers } from '@/mastra/review/markers'
import { normalizeReviewMessageBody } from '@/lib/review-threads'
import { parseProviderTimestamp } from '@/lib/timestamps'
import type { ReviewFindingState } from '@/db/schema'
import type { ReviewNoteEventPayload } from '@/server/webhook-events'
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
}): Promise<void> => {
  try {
    await params.provider.addThreadMessageReaction(params.mrIid, params.noteId, params.name)
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

const triageStateForCommand = (
  command: ReviewTriageCommand,
): { state: ReviewFindingState; reason: string | null } | null => {
  switch (command.kind) {
    case 'accept':
      return { state: 'accepted', reason: null }
    case 'reject':
      return { state: 'rejected', reason: command.reason }
    case 'defer':
      return { state: 'deferred', reason: command.reason }
    case 'fix_accepted':
    case 'invalid_defer':
      return null
  }
}

const triageResolutionReplyBody = (
  state: Extract<ReviewFindingState, 'rejected' | 'deferred'>,
  reason: string,
): string => {
  switch (state) {
    case 'rejected':
      return `Marked as rejected: ${reason}`
    case 'deferred':
      return `Deferred: ${reason}`
  }
}

const replyAndResolveTriageThread = async (params: {
  provider: ReviewProvider
  mrIid: number
  thread: ReviewThreadRecord
  state: Extract<ReviewFindingState, 'rejected' | 'deferred'>
  reason: string
}): Promise<void> => {
  const reply = await params.provider.replyToThread(
    params.mrIid,
    params.thread.providerThreadId,
    triageResolutionReplyBody(params.state, params.reason),
  )

  await persistOutboundReply({
    thread: params.thread,
    reviewRunId: params.thread.reviewRunId,
    reply,
    dependencies: getThreadSyncDependencies(),
  })

  await params.provider.resolveThread(params.mrIid, params.thread.providerThreadId)
  await markProviderThreadResolved({
    provider: params.provider.kind,
    providerThreadId: params.thread.providerThreadId,
    dependencies: getThreadSyncDependencies(),
  })
}

const applyReviewTriageCommand = async (params: {
  project: ProjectConfig
  provider: ReviewProvider
  mastra?: Mastra
  body: string
  botUsername: string
  projectKey: string
  mrIid: number
  fixLoopEnabled: boolean
  noteId: number
  thread: ReviewThreadRecord
  user: { id: number; username: string }
}): Promise<{ handled: boolean; acknowledged: boolean }> => {
  const command = parseReviewTriageCommand(params.body, params.botUsername)
  if (!command) {
    return { handled: false, acknowledged: false }
  }

  const trustedUsers = params.project.review.triage.trusted_usernames
  if (trustedUsers.length > 0 && !trustedUsers.includes(params.user.username)) {
    await params.provider.replyToThread(
      params.mrIid,
      params.thread.providerThreadId,
      `Mend ignored this command because ${params.user.username} is not configured as a trusted triage user.`,
    )
    return { handled: true, acknowledged: false }
  }

  if (command.kind === 'fix_accepted') {
    const outcome = await requestAcceptedFixBatch({
      projectKey: params.projectKey,
      mrIid: params.mrIid,
      enabled: params.fixLoopEnabled,
      force: command.force,
      requestNoteId: `${params.noteId}`,
      requestThreadId: params.thread.id,
      requestedByExternalId: `${params.user.id}`,
      requestedByName: params.user.username,
    })
    if (outcome.status === 'refused') {
      const reason =
        outcome.reason === 'fix_loop_disabled'
          ? 'The fix loop is disabled for this project.'
          : outcome.reason === 'no_accepted_findings'
            ? 'No accepted findings are ready to fix.'
            : `There are ${outcome.pendingCount} pending finding(s). Reply to each finding first, or use @mend fix accepted anyway.`
      await params.provider.replyToThread(params.mrIid, params.thread.providerThreadId, reason)
    } else if (outcome.status === 'queued' && params.mastra) {
      await ensureFixBatchRunner({
        mastra: params.mastra,
        project: params.project,
        mrIid: params.mrIid,
        dependencies: { enqueueMrReview },
      })
    }
    return { handled: true, acknowledged: outcome.status !== 'refused' }
  }

  const target = triageStateForCommand(command)
  if (!target) {
    return { handled: true, acknowledged: false }
  }

  const finding = await getReviewFindingByThreadId(params.thread.id)
  if (!finding) {
    return { handled: true, acknowledged: false }
  }

  if (finding.state !== target.state || finding.decisionReason !== target.reason) {
    await updateReviewFindingState({
      id: finding.id,
      state: target.state,
      decisionReason: target.reason,
      decidedByExternalId: `${params.user.id}`,
      decidedByName: params.user.username,
    })
  }

  if (target.state === 'rejected' || target.state === 'deferred') {
    await replyAndResolveTriageThread({
      provider: params.provider,
      mrIid: params.mrIid,
      thread: params.thread,
      state: target.state,
      reason: target.reason ?? 'Human triage.',
    })
  }

  return { handled: true, acknowledged: true }
}

export type { IsNoteAddressedToMendParams }
export { isNoteAddressedToMend }

export const processReviewNoteEvent = async (params: {
  project: ProjectConfig
  mastra?: Mastra
  payload: ReviewNoteEventPayload
}): Promise<void> => {
  const { project, payload } = params
  const provider = createReviewProvider(project)

  if (
    payload.object_attributes.noteable_type !== 'MergeRequest' ||
    !payload.merge_request ||
    payload.object_attributes.system
  ) {
    return
  }

  const currentUser = await provider.fetchCurrentUser()
  if (payload.user.id === currentUser.id) {
    return
  }

  const mrIid = payload.merge_request.iid
  const noteId = payload.object_attributes.id
  const noteAction = payload.object_attributes.action ?? 'create'
  const webhookDiscussionId = payload.object_attributes.discussion_id ?? undefined
  const directMention = mentionsBot(payload.object_attributes.note, currentUser.username)

  if (noteAction !== 'create') {
    return
  }

  let discussionId: string
  let discussion: ProviderThread | null = null
  let existingThread: ReviewThreadRecord | null = null
  let threadMessages: ReviewMessageRecord[] = []

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
    authorExternalId: `${payload.user.id}`,
    authorName: payload.user.username,
    direction: 'inbound',
    body: payload.object_attributes.note,
    providerMessageId: `${noteId}`,
    providerParentMessageId: null,
    providerUrl: payload.object_attributes.url ?? null,
    rawProviderData: payload,
    providerCreatedAt: parseProviderTimestamp(payload.object_attributes.created_at),
    providerUpdatedAt: parseProviderTimestamp(payload.object_attributes.updated_at),
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
    }).catch((error) => {
      console.warn(`[notes] failed to add eyes reaction to note ${noteId}: ${error}`)
    })

    const triageResult = await applyReviewTriageCommand({
      project,
      provider,
      mastra: params.mastra,
      body: payload.object_attributes.note,
      botUsername: currentUser.username,
      projectKey: project.key,
      mrIid,
      fixLoopEnabled: project.review.fix.enabled,
      noteId,
      thread,
      user: payload.user,
    })
    if (triageResult.handled) {
      if (triageResult.acknowledged) {
        await addReaction({
          provider,
          mrIid,
          noteId,
          name: 'white_check_mark',
        }).catch((error) => {
          console.warn(`[notes] failed to add success reaction to note ${noteId}: ${error}`)
        })
      }

      await completeReviewMessageProcessing(inboundMessage.id)
      return
    }

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
      noteBody: payload.object_attributes.note,
      botUsername: currentUser.username,
      trustedForProjectMemory: project.review.memory.project_scope_usernames.includes(
        payload.user.username,
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
            userQuestion: stripAllMendMarkers(payload.object_attributes.note),
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
            sourceBody:
              originalAgentBodyText ?? stripAllMendMarkers(payload.object_attributes.note),
          },
          createdByExternalId: `${payload.user.id}`,
          createdByName: payload.user.username,
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
      await provider.resolveThread(mrIid, discussionId)
      await markProviderThreadResolved({
        provider: provider.kind,
        providerThreadId: discussionId,
        dependencies: getThreadSyncDependencies(),
      })
    }

    if (addSuccessReaction) {
      await addReaction({
        provider,
        mrIid,
        noteId,
        name: 'white_check_mark',
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

export const processGitlabMergeRequestNote = processReviewNoteEvent
