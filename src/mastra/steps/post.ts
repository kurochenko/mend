import { createStep } from '@mastra/core/workflows'
import { getProject } from '@/config'
import { countPostedSuccessfulReviewRuns } from '@/db/review-runs'
import { createGitLabClient } from '@/integrations/gitlab/client'
import { fetchMrChangedFiles, fetchMrDiffRefs } from '@/integrations/gitlab/mr'
import { assertSafeGitRef, execGit } from '@/lib/exec'
import { parseDiff } from '@/lib/diff'
import {
  buildPreviousReviewContext,
  loadPublishedReviewThreadsForMr,
} from '@/mastra/review/previous-context'
import { executePostPlan } from '@/mastra/review/publish-executor'
import {
  buildPostPlan,
  emptyPostedThreadRef,
  renderPostPlanDryRun,
} from '@/mastra/review/publish-plan'
import { postStepInputSchema, postStepOutputSchema } from '@/mastra/review/run-result'
import type { ResolutionStats } from '@/server/thread-resolution'

const emptyResolutionStats = (): ResolutionStats => ({
  resolvedThreadCount: 0,
  partiallyFixedThreadCount: 0,
  unmatchedVerdictCount: 0,
})

export const postStep = createStep({
  id: 'post',
  inputSchema: postStepInputSchema,
  outputSchema: postStepOutputSchema,
  execute: async ({ inputData }) => {
    const project = getProject(inputData.projectKey)
    const gitlab = createGitLabClient(project)

    console.log(`[post] fetching diff refs for ${inputData.projectKey} MR !${inputData.mrIid}`)
    const [{ diffRefs }, { files: mrChangedFiles }, reviewRunCount, existingPublishedThreads] =
      await Promise.all([
        fetchMrDiffRefs(project, inputData.mrIid),
        fetchMrChangedFiles(project, inputData.mrIid),
        countPostedSuccessfulReviewRuns({
          projectKey: inputData.projectKey,
          mrIid: inputData.mrIid,
        }),
        loadPublishedReviewThreadsForMr({
          project,
          projectKey: inputData.projectKey,
          mrIid: inputData.mrIid,
        }),
      ])

    const mrDiffBase = assertSafeGitRef(diffRefs.base_sha, 'MR diff base ref')
    const diffOutput = await execGit(['diff', `${mrDiffBase}...HEAD`], inputData.worktreePath)
    const diffMap = parseDiff(diffOutput)
    const previousRunId = inputData.previousRunId
    const shouldResolveThreads =
      inputData.reviewMode === 'update' &&
      inputData.resolutionVerdicts.length > 0 &&
      previousRunId !== null
    const previousContext = shouldResolveThreads
      ? await buildPreviousReviewContext({
          project,
          mrIid: inputData.mrIid,
          previousRunId,
        })
      : null

    if (shouldResolveThreads && !previousContext) {
      console.warn(
        `[post] could not build previous review context for run ${inputData.previousRunId}`,
      )
    }

    const plan = buildPostPlan({
      input: inputData,
      diffRefs,
      diffMap,
      changedFiles: mrChangedFiles,
      reviewNumber: reviewRunCount + 1,
      existingPublishedThreads,
      previousContext,
    })

    if (inputData.inlineComments.length !== plan.inlineComments.length) {
      console.warn(
        `[post] dropped ${inputData.inlineComments.length - plan.inlineComments.length} inline comment(s) before posting`,
      )
    }

    if (plan.outOfScopeFindings.length > 0 || plan.outOfScopeInlineComments.length > 0) {
      console.warn(
        `[post] scope guard skipped ${plan.outOfScopeFindings.length} findings and ${plan.outOfScopeInlineComments.length} inline comments outside current MR diff`,
      )
    }

    const execution = inputData.featureFlags.dryRun
      ? {
          postedInlineComments: plan.inlineComments.map(() => emptyPostedThreadRef()),
          postedFindings: plan.findings.map(() => emptyPostedThreadRef()),
          threadedFindings: [],
          threadedInlineComments: [],
          preExistingDraftCount: 0,
          recoveredDraftCount: 0,
          draftRecoveryAction: 'none' as const,
          summaryNoteId: 0,
          persistedFindingCount: 0,
          resolutionStats: emptyResolutionStats(),
        }
      : await executePostPlan({ plan, project, gitlab })

    if (inputData.featureFlags.dryRun) {
      renderPostPlanDryRun(plan)
    }

    console.log(
      `[post] done: ${plan.inlineDrafts.length} inline, ${plan.skippedInlineComments.length} skipped`,
    )

    return {
      projectKey: inputData.projectKey,
      mrIid: inputData.mrIid,
      reviewRunId: inputData.reviewRunId,
      url: inputData.url,
      version: inputData.version,
      commitSha: inputData.commitSha,
      reviewMode: inputData.reviewMode,
      previousReviewedSha: inputData.previousReviewedSha,
      previousRunId: inputData.previousRunId,
      reviewIntent: inputData.reviewIntent,
      reviewIntentConfidence: inputData.reviewIntentConfidence,
      reviewIntentRationale: inputData.reviewIntentRationale,
      reviewTemplateId: inputData.reviewTemplateId,
      reviewTemplateSource: inputData.reviewTemplateSource,
      assessment: inputData.assessment,
      summary: inputData.summary,
      findings: plan.findings,
      inlineComments: plan.inlineComments,
      resolutionVerdicts: inputData.resolutionVerdicts,
      meta: inputData.meta,
      featureFlags: inputData.featureFlags,
      reviewDiagnostics: inputData.reviewDiagnostics,
      comparisonResult: inputData.comparisonResult,
      activeReviewMemoryEntries: inputData.activeReviewMemoryEntries,
      postedInlineComments: execution.postedInlineComments,
      postedFindings: execution.postedFindings,
      threadedFindings: execution.threadedFindings,
      threadedInlineComments: execution.threadedInlineComments,
      postDiagnostics: {
        ...plan.diagnostics,
        preExistingDraftCount: execution.preExistingDraftCount,
        recoveredDraftCount: execution.recoveredDraftCount,
        draftRecoveryAction: execution.draftRecoveryAction,
        resolvedThreadCount: execution.resolutionStats.resolvedThreadCount,
        partiallyFixedThreadCount: execution.resolutionStats.partiallyFixedThreadCount,
        unmatchedVerdictCount: execution.resolutionStats.unmatchedVerdictCount,
        persistedFindingCount: execution.persistedFindingCount,
        automaticFixBatchStatus: null,
      },
      posted: plan.inlineDrafts.length,
      skipped: plan.skippedInlineComments.length,
      reviewNumber: plan.reviewNumber,
      summaryNoteId: execution.summaryNoteId,
    }
  },
})
