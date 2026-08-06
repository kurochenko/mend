import { resolve } from 'node:path'
import { createStep } from '@mastra/core/workflows'
import { z } from 'zod'
import { getProject } from '@/config'
import { getReviewHarnessOverridesForTesting } from '@/agents/harness-overrides'
import { listActiveReviewMemory } from '@/db/review-memory'
import { toErrorMessage } from '@/lib/errors'
import { comparisonResultSchema, type ComparisonResult } from '@/mastra/review/comparison'
import { buildBugHistoryPromptSection } from '@/mastra/review/bug-history'
import {
  featureFlagsSchema,
  reviewDiagnosticsSchema,
  buildReviewDiagnostics,
  applyInspectionDiagnostics,
  applyReviewAgentDiagnostics,
} from '@/mastra/review/diagnostics'
import { buildReviewMemoryPromptSections } from '@/mastra/review/memory'
import { buildPreviousReviewContext } from '@/mastra/review/previous-context'
import { collectExpectedPriorBlockerIds } from '@/mastra/review/blocking-policy'
import {
  buildReviewSystemPrompt,
  DEFAULT_REVIEW_USER_PROMPT,
} from '@/mastra/review/prompt-templates'
import { collectStructuralSignals } from '@/mastra/review/structural-signals'
import {
  classifyIntentWithFallback,
  getEffectiveReviewAgentConfig,
  getReviewFeatureFlags,
  invokeReviewAgent,
  resolveReviewContext,
  selectEffectiveTemplate,
} from '@/mastra/review/review-pipeline'
import {
  parseReviewOutputV2,
  reviewOutputV2Schema,
  type ReviewOutputV2,
} from '@/mastra/review/schema'
import { activeReviewMemoryEntriesSchema } from '@/mastra/review/run-result'
import { partitionReviewScopeFiles } from '@/mastra/review/file-filter'
import { mrContextSchema } from '@/lib/review-events'
import { reviewModeContextSchema } from '@/lib/review-run-input'
import { intentMetadataSchema, stepPassthroughSchema } from '@/mastra/review/step-schemas'
import { selectReviewTemplate } from '@/mastra/review/template-selection'

const reviewStepInputSchema = mrContextSchema.merge(reviewModeContextSchema).extend({
  reviewRunId: z.string(),
  worktreePath: z.string(),
  commitSha: z.string(),
  context7ApiKey: z.string().nullable(),
  forceDryRun: z.boolean().optional(),
})

export const reviewStepOutputSchema = reviewOutputV2Schema
  .merge(stepPassthroughSchema)
  .merge(reviewModeContextSchema)
  .merge(intentMetadataSchema)
  .extend({
    featureFlags: featureFlagsSchema,
    reviewDiagnostics: reviewDiagnosticsSchema,
    comparisonResult: comparisonResultSchema,
    activeReviewMemoryEntries: activeReviewMemoryEntriesSchema,
  })

export type ReviewResult = ReviewOutputV2

const buildPromptMemorySections = async (params: {
  bugHistoryEnabled: boolean
  projectKey: string
  mrIid: number
  activeReviewMemory: Awaited<ReturnType<typeof listActiveReviewMemory>>
}): Promise<string[]> => {
  const bugHistorySection = params.bugHistoryEnabled
    ? await buildBugHistoryPromptSection({
        projectKey: params.projectKey,
        mrIid: params.mrIid,
      })
    : null
  return [
    ...(bugHistorySection ? [bugHistorySection] : []),
    ...buildReviewMemoryPromptSections(params.activeReviewMemory),
  ]
}

export const reviewStep = createStep({
  id: 'review',
  inputSchema: reviewStepInputSchema,
  outputSchema: reviewStepOutputSchema,
  execute: async ({ inputData }) => {
    const project = getProject(inputData.projectKey)

    const featureFlags = {
      ...getReviewFeatureFlags(project),
      dryRun: inputData.forceDryRun ? true : project.review.flags.dry_run,
    }
    const reviewAgentConfig = getEffectiveReviewAgentConfig(project)

    if (!featureFlags.schemaV2) {
      throw new Error('review.flags.schema_v2 is false, but this deployment requires schema v2')
    }

    const sessionDir = resolve('sessions', inputData.projectKey, `mr-${inputData.mrIid}`)

    const { contextPackage, diffBaseResolution } = await resolveReviewContext(project, {
      mrIid: inputData.mrIid,
      worktreePath: inputData.worktreePath,
      reviewMode: inputData.reviewMode,
      previousReviewedSha: inputData.previousReviewedSha,
      targetBranch: inputData.targetBranch,
    })

    const { includedFiles: reviewScopeFiles, excludedFiles: excludedScopeFiles } =
      partitionReviewScopeFiles(contextPackage.changedFiles)

    const structuralSignals = featureFlags.structuralSignals
      ? await collectStructuralSignals({
          worktreePath: inputData.worktreePath,
          diffBaseRef: contextPackage.baseRef,
          changedFiles: contextPackage.changedFiles,
          fileStats: contextPackage.fileStats,
          budget: {
            cruiseTimeoutMs: 30_000,
          },
        })
      : null

    if (excludedScopeFiles.length > 0) {
      const preview = excludedScopeFiles.slice(0, 6).join(', ')
      const suffix = excludedScopeFiles.length > 6 ? ', ...' : ''
      console.log(
        `[review] excluding generated or lock files from review scope (${excludedScopeFiles.length}/${contextPackage.changedFiles.length}): ${preview}${suffix}`,
      )
    }

    const { intentResult, intentClassifierFailure, intentClassifierDurationMs } =
      await classifyIntentWithFallback(
        project,
        {
          title: inputData.title,
          description: inputData.description,
          labels: inputData.labels,
          sourceBranch: inputData.sourceBranch,
          targetBranch: inputData.targetBranch,
          worktreePath: inputData.worktreePath,
        },
        reviewScopeFiles,
        sessionDir,
      )

    const templateResult = selectReviewTemplate({
      classifiedIntent: intentResult.intent,
      classifiedConfidence: intentResult.confidence,
      configTemplate: project.review.template.prompt,
      labels: inputData.labels,
      labelPrefix: project.review.template.label_prefix,
    })

    const effectiveTemplate = selectEffectiveTemplate(featureFlags, templateResult)

    const baseTemplateWarnings = [...effectiveTemplate.warnings, ...diffBaseResolution.warnings]

    if (excludedScopeFiles.length > 0) {
      const preview = excludedScopeFiles.slice(0, 6).join(', ')
      const suffix = excludedScopeFiles.length > 6 ? ', ...' : ''
      baseTemplateWarnings.push(
        `review scope excludes generated or lock files (${excludedScopeFiles.length}/${contextPackage.changedFiles.length}): ${preview}${suffix}`,
      )
    }

    let reviewDiagnostics = buildReviewDiagnostics({
      reviewMode: inputData.reviewMode,
      previousReviewedSha: inputData.previousReviewedSha,
      diffBaseRef: contextPackage.baseRef,
      changedFileCount: reviewScopeFiles.length,
      diffExcerptChars: contextPackage.diffExcerpt.length,
      diffTruncated: contextPackage.diffTruncated,
      intentClassifierModel: project.review.intent.model,
      intentClassifierDurationMs,
      intentClassifierFailure,
      intentSecondaryIntents: intentResult.secondaryIntents,
      agentHarness: reviewAgentConfig.harness,
      agentModel: reviewAgentConfig.model,
      templateWarnings: baseTemplateWarnings,
    })
    reviewDiagnostics.structuralSignals = structuralSignals
    reviewDiagnostics.contextPackageDiagnostics = contextPackage.diagnostics

    const previousReviewContext =
      inputData.reviewMode === 'update' && inputData.previousRunId
        ? await buildPreviousReviewContext({
            project,
            mrIid: inputData.mrIid,
            previousRunId: inputData.previousRunId,
          })
        : null

    const activeReviewMemory = await listActiveReviewMemory({
      projectKey: inputData.projectKey,
      mrIid: inputData.mrIid,
    })
    const memorySections = await buildPromptMemorySections({
      bugHistoryEnabled: featureFlags.bugHistory,
      projectKey: inputData.projectKey,
      mrIid: inputData.mrIid,
      activeReviewMemory,
    })

    if (previousReviewContext) {
      console.log(
        `[review] loaded previous review context: ${previousReviewContext.findings.length} findings, ${previousReviewContext.inlineComments.length} inline comments`,
      )
    }

    const instructions = buildReviewSystemPrompt({
      mrIid: inputData.mrIid,
      title: inputData.title,
      description: inputData.description,
      sourceBranch: inputData.sourceBranch,
      targetBranch: inputData.targetBranch,
      url: inputData.url,
      reviewMode: inputData.reviewMode,
      diffBaseRef: contextPackage.baseRef,
      previousReviewedSha: inputData.previousReviewedSha,
      contextPackage,
      structuralSignals,
      previousReviewContext,
      memorySections,
    })
    const prompt = DEFAULT_REVIEW_USER_PROMPT

    console.log(
      `[review] invoking ${reviewAgentConfig.harness} for ${inputData.projectKey} mr-${inputData.mrIid}`,
    )
    console.log(
      `[review] intent=${intentResult.intent} confidence=${intentResult.confidence.toFixed(2)} rationale=${intentResult.rationale.join(' | ')}`,
    )
    console.log(
      `[review] template=${effectiveTemplate.templateId} source=${effectiveTemplate.source}`,
    )
    for (const warning of effectiveTemplate.warnings) {
      console.warn(`[review] ${warning}`)
    }

    const { reviewResult, validatedReview, inspectionResult, comparisonExecutionResult } =
      await invokeReviewAgent({
        project,
        worktreePath: inputData.worktreePath,
        sessionDir,
        instructions,
        prompt,
        changedFiles: reviewScopeFiles,
        context7ApiKey: inputData.context7ApiKey,
        expectedPriorBlockerIds: collectExpectedPriorBlockerIds(previousReviewContext),
        harnesses: getReviewHarnessOverridesForTesting(),
      })
    reviewDiagnostics = applyReviewAgentDiagnostics(reviewDiagnostics, {
      harness: reviewResult.harness,
      model: reviewResult.model,
      durationMs: reviewResult.durationMs,
      sessionFile: reviewResult.sessionFile,
    })
    reviewDiagnostics = applyInspectionDiagnostics(reviewDiagnostics, {
      files: inspectionResult.inspectedFiles,
      changedFiles: inspectionResult.inspectedChangedFiles,
      changedFileCount: inspectionResult.inspectedChangedFileCount,
      changedFileCoverage: inspectionResult.inspectedChangedFileCoverage,
    })
    reviewDiagnostics.templateWarnings.push(...inspectionResult.templateWarnings)

    console.log(
      `[review] ${reviewResult.harness} completed for ${inputData.projectKey} mr-${inputData.mrIid}`,
    )

    const normalized = {
      ...validatedReview,
      meta: {
        templateId: effectiveTemplate.templateId,
        intent: intentResult.intent,
        confidence: intentResult.confidence,
        selectionSource: effectiveTemplate.source,
      },
    }

    let comparisonResult: ComparisonResult = null

    if (comparisonExecutionResult) {
      if (!comparisonExecutionResult.success) {
        comparisonResult = {
          harness: comparisonExecutionResult.harness,
          status: 'failed',
          durationMs: comparisonExecutionResult.durationMs,
          error:
            comparisonExecutionResult.error ??
            `${comparisonExecutionResult.harness} comparison failed`,
        }
      } else {
        try {
          const comparisonReview = parseReviewOutputV2(comparisonExecutionResult.output)
          comparisonResult = {
            harness: comparisonExecutionResult.harness,
            status: 'success',
            durationMs: comparisonExecutionResult.durationMs,
            review: comparisonReview,
          }
        } catch (error) {
          comparisonResult = {
            harness: comparisonExecutionResult.harness,
            status: 'failed',
            durationMs: comparisonExecutionResult.durationMs,
            error: toErrorMessage(error),
          }
        }
      }
    }

    const validatedComparisonResult = comparisonResultSchema.parse(comparisonResult)

    console.log(
      `[review] ${normalized.assessment}: ${normalized.findings.length} findings, ${normalized.inlineComments.length} inline comments`,
    )

    return {
      ...normalized,
      projectKey: inputData.projectKey,
      mrIid: inputData.mrIid,
      reviewRunId: inputData.reviewRunId,
      url: inputData.url,
      worktreePath: inputData.worktreePath,
      targetBranch: inputData.targetBranch,
      commitSha: inputData.commitSha,
      reviewMode: inputData.reviewMode,
      previousReviewedSha: inputData.previousReviewedSha,
      previousRunId: inputData.previousRunId,
      reviewIntent: intentResult.intent,
      reviewIntentConfidence: intentResult.confidence,
      reviewIntentRationale: intentResult.rationale,
      reviewTemplateId: effectiveTemplate.templateId,
      reviewTemplateSource: effectiveTemplate.source,
      featureFlags,
      reviewDiagnostics,
      comparisonResult: validatedComparisonResult,
      activeReviewMemoryEntries: activeReviewMemory,
    }
  },
})
