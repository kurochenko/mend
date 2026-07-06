import type { ProjectConfig } from '@/config'
import { createWithReconciliation } from '@/integrations/idempotent'
import type { ReviewProvider } from '@/integrations/provider/client'
import type { ProviderNote, ProviderThread } from '@/integrations/provider/types'
import { toErrorMessage } from '@/lib/errors'
import { buildInlineThreadFingerprint } from '@/lib/review-threads'
import { formatCommentBody } from '@/mastra/review/formatting'
import { isCurrentRunDraft, isMendDraft, parseMendMarkers } from '@/mastra/review/markers'
import type { PostPlan } from '@/mastra/review/publish-plan'
import { emptyPostedThreadRef } from '@/mastra/review/publish-plan'
import type {
  PostedFinding,
  PostedInlineComment,
  ThreadedFinding,
  ThreadedInlineComment,
} from '@/mastra/review/run-result'
import { executeThreadResolutions, type ResolutionStats } from '@/server/thread-resolution'
import { persistPostedReviewFindings, persistPublishedThreads } from '@/server/thread-sync'

export const findPublishedSummaryForRun = (
  notes: ProviderNote[],
  reviewRunId: string,
): ProviderNote | undefined =>
  notes.find((note) => {
    const markers = parseMendMarkers(note.body)
    return markers.runId === reviewRunId && markers.isSummary
  })

export const findMrNoteByBody = (notes: ProviderNote[], body: string): ProviderNote | undefined =>
  notes.find((note) => note.body === body)

const findThreadByBody = (threads: ProviderThread[], body: string): ProviderThread | undefined =>
  threads.find((thread) => thread.messages[0]?.body === body)

const createDiscussionWithReconciliation = async (params: {
  provider: ReviewProvider
  mrIid: number
  body: string
}): Promise<{ thread: ProviderThread; reconciled: boolean }> => {
  const result = await createWithReconciliation({
    action: 'Discussion creation',
    create: async () => await params.provider.createThread(params.mrIid, params.body),
    list: async () => await params.provider.listThreads(params.mrIid),
    match: (threads) => findThreadByBody(threads, params.body),
  })

  return { thread: result.value, reconciled: result.reconciled }
}

export const createMrNoteOnceByBody = async (params: {
  provider: ReviewProvider
  mrIid: number
  body: string
}): Promise<{ id: number; reconciled: boolean }> => {
  const notes = await params.provider.listNotes(params.mrIid)
  const existing = findMrNoteByBody(notes, params.body)
  if (existing) {
    return { id: existing.id, reconciled: true }
  }

  const created = await params.provider.createNote(params.mrIid, params.body)
  return { id: created.id, reconciled: false }
}

export interface PostExecutionResult {
  postedInlineComments: PostedInlineComment[]
  postedFindings: PostedFinding[]
  threadedFindings: ThreadedFinding[]
  threadedInlineComments: ThreadedInlineComment[]
  preExistingDraftCount: number
  recoveredDraftCount: number
  draftRecoveryAction: 'none' | 'reused' | 'cleaned'
  summaryNoteId: number
  persistedFindingCount: number
  resolutionStats: ResolutionStats
}

export const executePostPlan = async (params: {
  plan: PostPlan
  project: ProjectConfig
  provider: ReviewProvider
}): Promise<PostExecutionResult> => {
  const { plan, provider, project } = params
  const input = plan.input
  const publishResult = await provider.publishReviewBatch({
    changeNumber: input.mrIid,
    projectKey: input.projectKey,
    reviewRunId: input.reviewRunId,
    inlineDrafts: plan.inlineDrafts.map((draft) => ({
      path: draft.comment.file,
      body: draft.markedBody,
      anchor: draft.anchor,
      logLabel: `${draft.comment.file}:${draft.comment.line}`,
    })),
    summaryBody: plan.markedSummaryBody,
    diffRefs: plan.diffRefs,
    classifyDraft: (body) => {
      if (isCurrentRunDraft(body, input.reviewRunId)) {
        return 'current_run'
      }
      return isMendDraft(body) ? 'mend_other_run' : 'foreign'
    },
    matchSummaryNote: (notes) => findPublishedSummaryForRun(notes, input.reviewRunId),
  })
  const postedInlineComments: PostedInlineComment[] = plan.inlineComments.map(() =>
    emptyPostedThreadRef(),
  )
  const postedFindings: PostedFinding[] = plan.findings.map(() => emptyPostedThreadRef())
  const threadedFindings: ThreadedFinding[] = []
  const threadedInlineComments: ThreadedInlineComment[] = []

  let summaryNoteId = publishResult.summaryNoteId

  try {
    const threads = await provider.listThreads(input.mrIid)
    const persisted = await persistPublishedThreads({
      project,
      projectKey: input.projectKey,
      mrIid: input.mrIid,
      reviewRunId: input.reviewRunId,
      threads,
    })
    summaryNoteId = persisted.summaryNoteId ?? summaryNoteId
    const persistedInlineByFingerprint = new Map(
      persisted.inlineComments.map((comment) => [comment.findingFingerprint, comment] as const),
    )

    for (const [index, comment] of plan.inlineComments.entries()) {
      const fingerprint = buildInlineThreadFingerprint(
        comment.file,
        comment.line,
        formatCommentBody(comment),
      )
      const persistedComment = persistedInlineByFingerprint.get(fingerprint)
      postedInlineComments[index] = {
        providerThreadId: persistedComment?.providerThreadId ?? null,
        providerMessageId: persistedComment?.providerMessageId ?? null,
      }
    }
  } catch (error) {
    console.warn(
      `[post] failed to persist published review threads locally: ${toErrorMessage(error)}`,
    )
  }

  for (const draft of plan.findingDiscussions) {
    const result = await createDiscussionWithReconciliation({
      provider,
      mrIid: input.mrIid,
      body: draft.markedBody,
    })
    if (result.reconciled) {
      console.warn(
        `[post] re-used existing summary finding discussion for ${draft.previousFindingId} after ambiguous create failure`,
      )
    }

    const firstNote = result.thread.messages[0]
    let postedThread = {
      providerThreadId: result.thread.id,
      providerMessageId: firstNote ? firstNote.id : null,
    }

    try {
      const persisted = await persistPublishedThreads({
        project,
        projectKey: input.projectKey,
        mrIid: input.mrIid,
        reviewRunId: input.reviewRunId,
        threads: [result.thread],
      })
      const persistedDiscussion = persisted.summaryFindings.find(
        (entry) => entry.findingFingerprint === draft.fingerprint,
      )
      postedThread = {
        providerThreadId: persistedDiscussion?.providerThreadId ?? postedThread.providerThreadId,
        providerMessageId: persistedDiscussion?.providerMessageId ?? postedThread.providerMessageId,
      }
    } catch (error) {
      console.warn(
        `[post] failed to persist summary finding discussion ${draft.previousFindingId}: ${toErrorMessage(error)}`,
      )
    }

    if (draft.findingIndex !== null) {
      postedFindings[draft.findingIndex] = postedThread
    }

    if (draft.inlineCommentIndex !== null) {
      postedInlineComments[draft.inlineCommentIndex] = postedThread
    }

    if (draft.findingIndex === null && draft.finding) {
      threadedFindings.push({
        ...draft.finding,
        providerThreadId: postedThread.providerThreadId,
        providerMessageId: postedThread.providerMessageId,
      })
    }

    if (draft.inlineCommentIndex === null && draft.inlineComment) {
      threadedInlineComments.push({
        ...draft.inlineComment,
        providerThreadId: postedThread.providerThreadId,
        providerMessageId: postedThread.providerMessageId,
      })
    }
  }

  const persistedFindings = await persistPostedReviewFindings({
    project,
    projectKey: input.projectKey,
    mrIid: input.mrIid,
    reviewRunId: input.reviewRunId,
    findings: [
      ...plan.findings.map((finding, index) => ({
        ref: postedFindings[index] ?? emptyPostedThreadRef(),
        metadata: { kind: 'finding', finding },
      })),
      ...plan.inlineComments.map((inlineComment, index) => ({
        ref: postedInlineComments[index] ?? emptyPostedThreadRef(),
        metadata: { kind: 'inline_comment', inlineComment },
      })),
    ],
  })

  let resolutionStats: ResolutionStats = {
    resolvedThreadCount: 0,
    partiallyFixedThreadCount: 0,
    unmatchedVerdictCount: plan.unmatchedVerdictCount,
  }

  if (plan.threadResolutions.length > 0 || plan.unmatchedVerdictCount > 0) {
    console.log(
      `[post] resolving threads for ${input.resolutionVerdicts.length} resolution verdicts`,
    )
    resolutionStats = await executeThreadResolutions({
      provider,
      mrIid: input.mrIid,
      reviewRunId: input.reviewRunId,
      resolutions: plan.threadResolutions,
      unmatchedVerdictCount: plan.unmatchedVerdictCount,
    })
    console.log(
      `[post] thread resolution: ${resolutionStats.resolvedThreadCount} resolved, ${resolutionStats.partiallyFixedThreadCount} partially fixed, ${resolutionStats.unmatchedVerdictCount} unmatched`,
    )
  }

  return {
    postedInlineComments,
    postedFindings,
    threadedFindings,
    threadedInlineComments,
    preExistingDraftCount: publishResult.preExistingDraftCount,
    recoveredDraftCount: publishResult.recoveredDraftCount,
    draftRecoveryAction: publishResult.draftRecoveryAction,
    summaryNoteId,
    persistedFindingCount: persistedFindings.length,
    resolutionStats,
  }
}
