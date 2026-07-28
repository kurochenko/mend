import type { GitLabProjectConfig } from '@/config'
import { createWithReconciliation } from '@/integrations/idempotent'
import {
  createDiscussion,
  getMrDiscussion,
  listMrDiscussions,
  replyToDiscussion,
  resolveDiscussion,
  type Discussion,
  type DiscussionNote,
} from '@/integrations/gitlab/discussions'
import {
  addDiscussionNoteReaction,
  addMergeRequestNoteReaction,
} from '@/integrations/gitlab/reactions'
import { fetchMr, fetchMrChangedFiles, fetchMrDiffRefs } from '@/integrations/gitlab/mr'
import {
  bulkPublishDrafts,
  createDraftNote,
  createMrNote,
  deleteDraftNote,
  deleteMrNote,
  fetchCurrentUser,
  listMrDraftNotes,
  listMrNotes,
  publishDraftNote,
  updateMrNote,
  type DraftNotePosition,
  type MrDraftNote,
} from '@/integrations/gitlab/notes'
import type {
  DiffRefs,
  DraftClassification,
  PublishBatchResult,
  PublishInlineDraft,
  ProviderNote,
  ProviderThread,
  ProviderThreadMessage,
  ThreadPosition,
} from '@/integrations/provider/types'

interface GitLabPublishReviewBatchParams {
  changeNumber: number
  projectKey: string
  reviewRunId: string
  inlineDrafts: PublishInlineDraft[]
  summaryBody: string
  diffRefs: DiffRefs
  classifyDraft: (body: string) => DraftClassification
  matchSummaryNote: (notes: ProviderNote[]) => ProviderNote | undefined
}

const readPositionString = (position: unknown, key: 'new_path' | 'old_path'): string | null => {
  if (!position || typeof position !== 'object') {
    return null
  }

  const value = (position as Record<string, unknown>)[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

const readPositionLine = (position: unknown, key: 'new_line' | 'old_line'): number | null => {
  if (!position || typeof position !== 'object') {
    return null
  }

  const value = (position as Record<string, unknown>)[key]
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null
}

const normalizePosition = (position: unknown): ThreadPosition | null => {
  const normalized = {
    path: readPositionString(position, 'new_path'),
    oldPath: readPositionString(position, 'old_path'),
    line: readPositionLine(position, 'new_line'),
    oldLine: readPositionLine(position, 'old_line'),
  }

  if (
    normalized.path === null &&
    normalized.oldPath === null &&
    normalized.line === null &&
    normalized.oldLine === null
  ) {
    return null
  }

  return normalized
}

const mapThreadMessage = (note: DiscussionNote): ProviderThreadMessage => ({
  id: `${note.id}`,
  body: note.body,
  author: note.author,
  resolvable: note.resolvable,
  resolved: note.resolved,
  system: note.system,
  createdAt: note.createdAt,
  updatedAt: note.updatedAt,
  url: note.url,
  position: normalizePosition(note.position),
  raw: note.raw,
})

const mapThread = (discussion: Discussion): ProviderThread => ({
  id: discussion.id,
  isThread: !discussion.individual_note,
  messages: discussion.notes.map(mapThreadMessage),
  raw: discussion.raw,
})

const mapDiffRefs = (diffRefs: {
  base_sha: string
  head_sha: string
  start_sha?: string
}): DiffRefs => ({
  baseSha: diffRefs.base_sha,
  headSha: diffRefs.head_sha,
  startSha: diffRefs.start_sha,
})

const findDraftByBody = (drafts: MrDraftNote[], body: string): MrDraftNote | undefined =>
  drafts.find((draft) => draft.body === body)

const findPublishedSummaryForRun = (
  notes: ProviderNote[],
  matchSummaryNote: (notes: ProviderNote[]) => ProviderNote | undefined,
): ProviderNote | undefined => matchSummaryNote(notes)

const classifyAndCleanPreExistingDrafts = async (params: {
  project: GitLabProjectConfig
  projectKey: string
  changeNumber: number
  reviewRunId: string
  classifyDraft: (body: string) => DraftClassification
}): Promise<{
  preExistingDraftCount: number
  recoveredDraftCount: number
  draftRecoveryAction: 'none' | 'reused' | 'cleaned'
}> => {
  const preExistingDrafts = await listMrDraftNotes(params.project, params.changeNumber)
  const preExistingDraftCount = preExistingDrafts.length

  if (preExistingDraftCount === 0) {
    return {
      preExistingDraftCount,
      recoveredDraftCount: 0,
      draftRecoveryAction: 'none',
    }
  }

  const currentRunDrafts = preExistingDrafts.filter(
    (draft) => params.classifyDraft(draft.body) === 'current_run',
  )

  if (currentRunDrafts.length === preExistingDraftCount) {
    for (const draft of currentRunDrafts) {
      await deleteDraftNote(params.project, params.changeNumber, draft.id)
    }

    return {
      preExistingDraftCount,
      recoveredDraftCount: currentRunDrafts.length,
      draftRecoveryAction: 'cleaned',
    }
  }

  const otherRunMendDraftCount = preExistingDrafts.filter(
    (draft) => params.classifyDraft(draft.body) === 'mend_other_run',
  ).length
  const foreignDraftCount = preExistingDraftCount - currentRunDrafts.length - otherRunMendDraftCount

  throw new Error(
    `Refusing to bulk publish drafts for ${params.projectKey} MR !${params.changeNumber}: found ${preExistingDraftCount} pre-existing draft notes (${currentRunDrafts.length} current-run, ${otherRunMendDraftCount} other-run, ${foreignDraftCount} foreign)`,
  )
}

const buildDraftNotePosition = (params: {
  diffRefs: DiffRefs
  draft: PublishInlineDraft
}): DraftNotePosition => {
  if (!params.diffRefs.startSha) {
    throw new Error('GitLab draft note publishing requires diffRefs.startSha')
  }

  return {
    position_type: 'text',
    base_sha: params.diffRefs.baseSha,
    head_sha: params.diffRefs.headSha,
    start_sha: params.diffRefs.startSha,
    old_path: params.draft.path,
    new_path: params.draft.path,
    ...params.draft.anchor,
  }
}

const createDraftNoteWithReconciliation = async (params: {
  project: GitLabProjectConfig
  changeNumber: number
  draft: PublishInlineDraft
  diffRefs: DiffRefs
}): Promise<{ id: number; reconciled: boolean }> => {
  const position = buildDraftNotePosition({
    diffRefs: params.diffRefs,
    draft: params.draft,
  })
  const result = await createWithReconciliation({
    action: 'Draft note creation',
    create: async () =>
      await createDraftNote(params.project, params.changeNumber, params.draft.body, position),
    list: async () => await listMrDraftNotes(params.project, params.changeNumber),
    match: (drafts) => findDraftByBody(drafts, params.draft.body),
  })

  return { id: result.value.id, reconciled: result.reconciled }
}

const bulkPublishDraftsWithReconciliation = async (params: {
  project: GitLabProjectConfig
  changeNumber: number
  reviewRunId: string
  classifyDraft: (body: string) => DraftClassification
}): Promise<{ reconciled: boolean }> => {
  const result = await createWithReconciliation({
    action: 'Draft bulk publish',
    create: async () => {
      await bulkPublishDrafts(params.project, params.changeNumber)
      return true
    },
    list: async () => await listMrDraftNotes(params.project, params.changeNumber),
    match: async (drafts) => {
      const remainingCurrentRunDrafts = drafts.filter(
        (draft) => params.classifyDraft(draft.body) === 'current_run',
      )

      if (remainingCurrentRunDrafts.length === 0) {
        return true
      }

      for (const draft of remainingCurrentRunDrafts) {
        await publishDraftNote(params.project, params.changeNumber, draft.id)
      }

      const draftsAfterIndividualPublish = await listMrDraftNotes(
        params.project,
        params.changeNumber,
      )
      const remainingCurrentRunDraftsAfterIndividualPublish = draftsAfterIndividualPublish.filter(
        (draft) => params.classifyDraft(draft.body) === 'current_run',
      )

      return remainingCurrentRunDraftsAfterIndividualPublish.length === 0 ? true : undefined
    },
  })

  return { reconciled: result.reconciled }
}

const createSummaryNoteWithReconciliation = async (params: {
  project: GitLabProjectConfig
  changeNumber: number
  body: string
  matchSummaryNote: (notes: ProviderNote[]) => ProviderNote | undefined
}): Promise<{ id: number; reconciled: boolean }> => {
  const result = await createWithReconciliation({
    action: 'Summary note creation',
    create: async () => await createMrNote(params.project, params.changeNumber, params.body),
    list: async () => await listMrNotes(params.project, params.changeNumber),
    match: (notes) => findPublishedSummaryForRun(notes, params.matchSummaryNote),
  })

  return { id: result.value.id, reconciled: result.reconciled }
}

const publishReviewBatch = async (
  project: GitLabProjectConfig,
  params: GitLabPublishReviewBatchParams,
): Promise<PublishBatchResult> => {
  const draftRecovery = await classifyAndCleanPreExistingDrafts({
    project,
    projectKey: params.projectKey,
    changeNumber: params.changeNumber,
    reviewRunId: params.reviewRunId,
    classifyDraft: params.classifyDraft,
  })

  for (const draft of params.inlineDrafts) {
    console.log(`[post] creating draft note on ${draft.logLabel}`)
    const result = await createDraftNoteWithReconciliation({
      project,
      changeNumber: params.changeNumber,
      draft,
      diffRefs: params.diffRefs,
    })
    if (result.reconciled) {
      console.warn(
        `[post] re-used existing draft note on ${draft.logLabel} after ambiguous create failure`,
      )
    }
  }

  if (params.inlineDrafts.length > 0) {
    console.log(`[post] bulk publishing ${params.inlineDrafts.length} inline draft notes`)
    const publishResult = await bulkPublishDraftsWithReconciliation({
      project,
      changeNumber: params.changeNumber,
      reviewRunId: params.reviewRunId,
      classifyDraft: params.classifyDraft,
    })
    if (publishResult.reconciled) {
      console.warn(
        '[post] bulk publish returned an error but current-run inline drafts appear published; continuing',
      )
    }
  }

  console.log('[post] creating summary note')
  const summaryNote = await createSummaryNoteWithReconciliation({
    project,
    changeNumber: params.changeNumber,
    body: params.summaryBody,
    matchSummaryNote: params.matchSummaryNote,
  })
  if (summaryNote.reconciled) {
    console.warn('[post] re-used existing summary note after ambiguous create failure')
  }

  return {
    ...draftRecovery,
    summaryNoteId: summaryNote.id,
    summaryReconciled: summaryNote.reconciled,
  }
}

export const createGitLabReviewProvider = (project: GitLabProjectConfig) => ({
  kind: 'gitlab' as const,
  fetchCurrentUser: async () => await fetchCurrentUser(project),
  fetchChangeRequest: async (changeNumber: number) => await fetchMr(project, changeNumber),
  fetchDiffRefs: async (changeNumber: number) => {
    const { diffRefs } = await fetchMrDiffRefs(project, changeNumber)
    return mapDiffRefs(diffRefs)
  },
  fetchChangedFiles: async (changeNumber: number) => {
    const { files } = await fetchMrChangedFiles(project, changeNumber)
    return files
  },
  listNotes: async (changeNumber: number) => await listMrNotes(project, changeNumber),
  createNote: async (changeNumber: number, body: string) =>
    await createMrNote(project, changeNumber, body),
  updateNote: async (changeNumber: number, noteId: number, body: string) =>
    await updateMrNote(project, changeNumber, noteId, body),
  deleteNote: async (changeNumber: number, noteId: number) =>
    await deleteMrNote(project, changeNumber, noteId),
  listThreads: async (changeNumber: number) =>
    (await listMrDiscussions(project, changeNumber)).map(mapThread),
  getThread: async (changeNumber: number, threadId: string) =>
    mapThread(await getMrDiscussion(project, changeNumber, threadId)),
  createThread: async (changeNumber: number, body: string) =>
    mapThread(await createDiscussion(project, changeNumber, body)),
  replyToThread: async (changeNumber: number, threadId: string, body: string) =>
    mapThreadMessage(await replyToDiscussion(project, changeNumber, threadId, body)),
  resolveThread: async (changeNumber: number, threadId: string) => {
    await resolveDiscussion(project, changeNumber, threadId)
    return true
  },
  addNoteReaction: async (changeNumber: number, noteId: number, reaction: string) =>
    await addMergeRequestNoteReaction(project, { mrIid: changeNumber, noteId, name: reaction }),
  addThreadMessageReaction: async (changeNumber: number, messageId: number, reaction: string) =>
    await addDiscussionNoteReaction(project, {
      mrIid: changeNumber,
      discussionId: '',
      noteId: messageId,
      name: reaction,
    }),
  publishReviewBatch: async (params: GitLabPublishReviewBatchParams) =>
    await publishReviewBatch(project, params),
})
