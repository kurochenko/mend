import { z } from 'zod'
import type { GitHubProjectConfig } from '@/config'
import { createPrIssueComment, listPrIssueComments } from '@/integrations/github/comments'
import { githubApi, githubPaginated } from '@/integrations/github/transport'
import { githubRepoPath } from '@/integrations/github/pr'
import { createWithReconciliation } from '@/integrations/idempotent'
import type {
  DraftClassification,
  PublishBatchResult,
  PublishInlineDraft,
  ProviderNote,
  ProviderUser,
  DiffRefs,
} from '@/integrations/provider/types'

interface GitHubPublishReviewBatchParams {
  changeNumber: number
  projectKey: string
  reviewRunId: string
  inlineDrafts: PublishInlineDraft[]
  summaryBody: string
  diffRefs: DiffRefs
  classifyDraft: (body: string) => DraftClassification
  matchSummaryNote: (notes: ProviderNote[]) => ProviderNote | undefined
  currentUser: ProviderUser
}

const reviewSchema = z
  .object({
    id: z.number(),
    state: z.string(),
    user: z.object({ id: z.number(), login: z.string() }).nullable().optional(),
  })
  .passthrough()

const reviewCommentSchema = z
  .object({
    id: z.number(),
    body: z.string(),
  })
  .passthrough()

const reviewsPath = (project: GitHubProjectConfig, prNumber: number): string =>
  `${githubRepoPath(project)}/pulls/${prNumber}/reviews`

const listReviews = async (project: GitHubProjectConfig, prNumber: number) =>
  await githubPaginated(project, `${reviewsPath(project, prNumber)}?per_page=100`, (value) =>
    z.array(reviewSchema).parse(value),
  )

const listReviewComments = async (
  project: GitHubProjectConfig,
  prNumber: number,
  reviewId: number,
) =>
  await githubPaginated(
    project,
    `${reviewsPath(project, prNumber)}/${reviewId}/comments?per_page=100`,
    (value) => z.array(reviewCommentSchema).parse(value),
  )

const listPullRequestReviewComments = async (project: GitHubProjectConfig, prNumber: number) =>
  await githubPaginated(
    project,
    `${githubRepoPath(project)}/pulls/${prNumber}/comments?per_page=100`,
    (value) => z.array(reviewCommentSchema).parse(value),
  )

const classifyPendingReviews = async (params: {
  project: GitHubProjectConfig
  projectKey: string
  changeNumber: number
  currentUser: ProviderUser
  classifyDraft: (body: string) => DraftClassification
}): Promise<{
  preExistingDraftCount: number
  recoveredDraftCount: number
  draftRecoveryAction: 'none' | 'reused' | 'cleaned'
}> => {
  const pendingReviews = (await listReviews(params.project, params.changeNumber)).filter(
    (review) => review.state === 'PENDING' && review.user?.id === params.currentUser.id,
  )

  const classified: DraftClassification[] = []
  for (const review of pendingReviews) {
    const comments = await listReviewComments(params.project, params.changeNumber, review.id)
    classified.push(...comments.map((comment) => params.classifyDraft(comment.body)))
  }

  const preExistingDraftCount = classified.length
  if (pendingReviews.length === 0) {
    return {
      preExistingDraftCount: 0,
      recoveredDraftCount: 0,
      draftRecoveryAction: 'none',
    }
  }

  const currentRunCount = classified.filter((value) => value === 'current_run').length
  const otherRunCount = classified.filter((value) => value === 'mend_other_run').length
  const foreignCount = preExistingDraftCount - currentRunCount - otherRunCount

  if (currentRunCount === preExistingDraftCount && otherRunCount === 0 && foreignCount === 0) {
    for (const review of pendingReviews) {
      await githubApi(
        params.project,
        `${reviewsPath(params.project, params.changeNumber)}/${review.id}`,
        { method: 'DELETE' },
        undefined,
        { maxRetries: 0 },
      )
    }

    return {
      preExistingDraftCount,
      recoveredDraftCount: preExistingDraftCount,
      draftRecoveryAction: 'cleaned',
    }
  }

  throw new Error(
    `Refusing to publish review for ${params.projectKey} PR #${params.changeNumber}: found ${preExistingDraftCount} pending review comments (${currentRunCount} current-run, ${otherRunCount} other-run, ${foreignCount} foreign)`,
  )
}

const mapReviewComment = (draft: PublishInlineDraft) => ({
  path: draft.path,
  body: draft.body,
  ...(draft.anchor.new_line
    ? { line: draft.anchor.new_line, side: 'RIGHT' }
    : { line: draft.anchor.old_line, side: 'LEFT' }),
})

const publishInlineReview = async (params: {
  project: GitHubProjectConfig
  changeNumber: number
  inlineDrafts: PublishInlineDraft[]
  diffRefs: DiffRefs
}): Promise<{ reconciled: boolean }> => {
  if (params.inlineDrafts.length === 0) {
    return { reconciled: false }
  }

  const result = await createWithReconciliation({
    action: 'GitHub inline review publish',
    create: async () => {
      await githubApi(
        params.project,
        reviewsPath(params.project, params.changeNumber),
        {
          method: 'POST',
          body: JSON.stringify({
            commit_id: params.diffRefs.headSha,
            event: 'COMMENT',
            comments: params.inlineDrafts.map(mapReviewComment),
          }),
        },
        undefined,
        { maxRetries: 0 },
      )
      return true
    },
    list: async () => await listPullRequestReviewComments(params.project, params.changeNumber),
    match: (comments) =>
      params.inlineDrafts.every((draft) => comments.some((comment) => comment.body === draft.body))
        ? true
        : undefined,
  })

  return { reconciled: result.reconciled }
}

const createSummaryNoteWithReconciliation = async (params: {
  project: GitHubProjectConfig
  changeNumber: number
  body: string
  matchSummaryNote: (notes: ProviderNote[]) => ProviderNote | undefined
}): Promise<{ id: number; reconciled: boolean }> => {
  const result = await createWithReconciliation({
    action: 'Summary note creation',
    create: async () =>
      await createPrIssueComment(params.project, params.changeNumber, params.body),
    list: async () => await listPrIssueComments(params.project, params.changeNumber),
    match: (notes) => params.matchSummaryNote(notes),
  })

  return { id: result.value.id, reconciled: result.reconciled }
}

export const publishReviewBatch = async (
  project: GitHubProjectConfig,
  params: GitHubPublishReviewBatchParams,
): Promise<PublishBatchResult> => {
  const draftRecovery = await classifyPendingReviews({
    project,
    projectKey: params.projectKey,
    changeNumber: params.changeNumber,
    currentUser: params.currentUser,
    classifyDraft: params.classifyDraft,
  })

  if (params.inlineDrafts.length > 0) {
    for (const draft of params.inlineDrafts) {
      console.log(`[post] creating draft note on ${draft.logLabel}`)
    }
    console.log(`[post] bulk publishing ${params.inlineDrafts.length} inline draft notes`)
    const publishResult = await publishInlineReview({
      project,
      changeNumber: params.changeNumber,
      inlineDrafts: params.inlineDrafts,
      diffRefs: params.diffRefs,
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
