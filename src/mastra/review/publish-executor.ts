import type { GitLabClient } from '@/integrations/gitlab/client'
import type { ProjectConfig } from '@/config'
import { createWithReconciliation } from '@/integrations/gitlab/idempotent'
import type { Discussion } from '@/integrations/gitlab/discussions'
import type { MrDraftNote, MrNote } from '@/integrations/gitlab/notes'
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
import {
  persistPostedReviewFindings,
  persistPublishedGitLabDiscussions,
} from '@/server/thread-sync'

const findDraftByBody = (drafts: MrDraftNote[], body: string): MrDraftNote | undefined =>
  drafts.find((draft) => draft.body === body)

export const findPublishedSummaryForRun = (
  notes: MrNote[],
  reviewRunId: string,
): MrNote | undefined =>
  notes.find((note) => {
    const markers = parseMendMarkers(note.body)
    return markers.runId === reviewRunId && markers.isSummary
  })

export const findMrNoteByBody = (notes: MrNote[], body: string): MrNote | undefined =>
  notes.find((note) => note.body === body)

const findDiscussionByBody = (discussions: Discussion[], body: string): Discussion | undefined =>
  discussions.find((discussion) => discussion.notes[0]?.body === body)

const classifyAndCleanPreExistingDrafts = async (params: {
  gitlab: GitLabClient
  projectKey: string
  mrIid: number
  reviewRunId: string
}): Promise<{
  preExistingDraftCount: number
  recoveredDraftCount: number
  draftRecoveryAction: 'none' | 'reused' | 'cleaned'
}> => {
  const preExistingDrafts = await params.gitlab.listMrDraftNotes(params.mrIid)
  const preExistingDraftCount = preExistingDrafts.length

  if (preExistingDraftCount === 0) {
    return {
      preExistingDraftCount,
      recoveredDraftCount: 0,
      draftRecoveryAction: 'none',
    }
  }

  const currentRunDrafts = preExistingDrafts.filter((draft) =>
    isCurrentRunDraft(draft.body, params.reviewRunId),
  )

  if (currentRunDrafts.length === preExistingDraftCount) {
    for (const draft of currentRunDrafts) {
      await params.gitlab.deleteDraftNote(params.mrIid, draft.id)
    }

    return {
      preExistingDraftCount,
      recoveredDraftCount: currentRunDrafts.length,
      draftRecoveryAction: 'cleaned',
    }
  }

  const otherRunMendDraftCount = preExistingDrafts.filter(
    (draft) => isMendDraft(draft.body) && !isCurrentRunDraft(draft.body, params.reviewRunId),
  ).length
  const foreignDraftCount = preExistingDraftCount - currentRunDrafts.length - otherRunMendDraftCount

  throw new Error(
    `Refusing to bulk publish drafts for ${params.projectKey} MR !${params.mrIid}: found ${preExistingDraftCount} pre-existing draft notes (${currentRunDrafts.length} current-run, ${otherRunMendDraftCount} other-run, ${foreignDraftCount} foreign)`,
  )
}

const createDraftNoteWithReconciliation = async (params: {
  gitlab: GitLabClient
  mrIid: number
  note: string
  position: PostPlan['inlineDrafts'][number]['position']
}): Promise<{ id: number; reconciled: boolean }> => {
  const result = await createWithReconciliation({
    action: 'Draft note creation',
    create: async () =>
      await params.gitlab.createDraftNote(params.mrIid, params.note, params.position),
    list: async () => await params.gitlab.listMrDraftNotes(params.mrIid),
    match: (drafts) => findDraftByBody(drafts, params.note),
  })

  return { id: result.value.id, reconciled: result.reconciled }
}

const bulkPublishDraftsWithReconciliation = async (params: {
  gitlab: GitLabClient
  mrIid: number
  reviewRunId: string
}): Promise<{ reconciled: boolean }> => {
  const result = await createWithReconciliation({
    action: 'Draft bulk publish',
    create: async () => {
      await params.gitlab.bulkPublishDrafts(params.mrIid)
      return true
    },
    list: async () => await params.gitlab.listMrDraftNotes(params.mrIid),
    match: async (drafts) => {
      const remainingCurrentRunDrafts = drafts.filter((draft) =>
        isCurrentRunDraft(draft.body, params.reviewRunId),
      )

      if (remainingCurrentRunDrafts.length === 0) {
        return true
      }

      for (const draft of remainingCurrentRunDrafts) {
        await params.gitlab.publishDraftNote(params.mrIid, draft.id)
      }

      const draftsAfterIndividualPublish = await params.gitlab.listMrDraftNotes(params.mrIid)
      const remainingCurrentRunDraftsAfterIndividualPublish = draftsAfterIndividualPublish.filter(
        (draft) => isCurrentRunDraft(draft.body, params.reviewRunId),
      )

      return remainingCurrentRunDraftsAfterIndividualPublish.length === 0 ? true : undefined
    },
  })

  return { reconciled: result.reconciled }
}

const createMrNoteWithReconciliation = async (params: {
  gitlab: GitLabClient
  mrIid: number
  body: string
  reviewRunId: string
}): Promise<{ id: number; reconciled: boolean }> => {
  const result = await createWithReconciliation({
    action: 'Summary note creation',
    create: async () => await params.gitlab.createMrNote(params.mrIid, params.body),
    list: async () => await params.gitlab.listMrNotes(params.mrIid),
    match: (notes) => findPublishedSummaryForRun(notes, params.reviewRunId),
  })

  return { id: result.value.id, reconciled: result.reconciled }
}

const createDiscussionWithReconciliation = async (params: {
  gitlab: GitLabClient
  mrIid: number
  body: string
}): Promise<{ discussion: Discussion; reconciled: boolean }> => {
  const result = await createWithReconciliation({
    action: 'Discussion creation',
    create: async () => await params.gitlab.createDiscussion(params.mrIid, params.body),
    list: async () => await params.gitlab.listMrDiscussions(params.mrIid),
    match: (discussions) => findDiscussionByBody(discussions, params.body),
  })

  return { discussion: result.value, reconciled: result.reconciled }
}

export const createMrNoteOnceByBody = async (params: {
  gitlab: GitLabClient
  mrIid: number
  body: string
}): Promise<{ id: number; reconciled: boolean }> => {
  const notes = await params.gitlab.listMrNotes(params.mrIid)
  const existing = findMrNoteByBody(notes, params.body)
  if (existing) {
    return { id: existing.id, reconciled: true }
  }

  const created = await params.gitlab.createMrNote(params.mrIid, params.body)
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
  gitlab: GitLabClient
}): Promise<PostExecutionResult> => {
  const { plan, gitlab, project } = params
  const input = plan.input
  const draftRecovery = await classifyAndCleanPreExistingDrafts({
    gitlab,
    projectKey: input.projectKey,
    mrIid: input.mrIid,
    reviewRunId: input.reviewRunId,
  })
  const postedInlineComments: PostedInlineComment[] = plan.inlineComments.map(() =>
    emptyPostedThreadRef(),
  )
  const postedFindings: PostedFinding[] = plan.findings.map(() => emptyPostedThreadRef())
  const threadedFindings: ThreadedFinding[] = []
  const threadedInlineComments: ThreadedInlineComment[] = []

  for (const draft of plan.inlineDrafts) {
    console.log(`[post] creating draft note on ${draft.comment.file}:${draft.comment.line}`)
    const result = await createDraftNoteWithReconciliation({
      gitlab,
      mrIid: input.mrIid,
      note: draft.markedBody,
      position: draft.position,
    })
    if (result.reconciled) {
      console.warn(
        `[post] re-used existing draft note on ${draft.comment.file}:${draft.comment.line} after ambiguous create failure`,
      )
    }
  }

  if (plan.inlineDrafts.length > 0) {
    console.log(`[post] bulk publishing ${plan.inlineDrafts.length} inline draft notes`)
    const publishResult = await bulkPublishDraftsWithReconciliation({
      gitlab,
      mrIid: input.mrIid,
      reviewRunId: input.reviewRunId,
    })
    if (publishResult.reconciled) {
      console.warn(
        '[post] bulk publish returned an error but current-run inline drafts appear published; continuing',
      )
    }
  }

  console.log('[post] creating summary note')
  const summaryNote = await createMrNoteWithReconciliation({
    gitlab,
    mrIid: input.mrIid,
    body: plan.markedSummaryBody,
    reviewRunId: input.reviewRunId,
  })
  let summaryNoteId = summaryNote.id
  if (summaryNote.reconciled) {
    console.warn('[post] re-used existing summary note after ambiguous create failure')
  }

  try {
    const discussions = await gitlab.listMrDiscussions(input.mrIid)
    const persisted = await persistPublishedGitLabDiscussions({
      project,
      projectKey: input.projectKey,
      mrIid: input.mrIid,
      reviewRunId: input.reviewRunId,
      discussions,
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
      gitlab,
      mrIid: input.mrIid,
      body: draft.markedBody,
    })
    if (result.reconciled) {
      console.warn(
        `[post] re-used existing summary finding discussion for ${draft.previousFindingId} after ambiguous create failure`,
      )
    }

    const firstNote = result.discussion.notes[0]
    let postedThread = {
      providerThreadId: result.discussion.id,
      providerMessageId: firstNote ? `${firstNote.id}` : null,
    }

    try {
      const persisted = await persistPublishedGitLabDiscussions({
        project,
        projectKey: input.projectKey,
        mrIid: input.mrIid,
        reviewRunId: input.reviewRunId,
        discussions: [result.discussion],
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
      gitlab,
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
    ...draftRecovery,
    summaryNoteId,
    persistedFindingCount: persistedFindings.length,
    resolutionStats,
  }
}
