import { resolve } from 'node:path'
import type { ProjectConfig } from '@/config'
import { invokeCodexReview } from '@/agents/codex-harness'
import { createEnsembleReviewHarness, defaultEnsembleConfig } from '@/agents/ensemble-harness'
import { invokeOpenCodeReview } from '@/agents/opencode-harness'
import { invokePiReview } from '@/agents/pi-harness'
import type {
  ReviewAgentHarness,
  ReviewAgentHarnessId,
  ReviewAgentResult,
  ReviewAgentThinkingLevel,
} from '@/agents/review-harness'
import { createReviewProvider } from '@/integrations/provider/client'
import { ensureCommitsAvailable, refetchOrigin } from '@/integrations/repo-remote'
import { toErrorMessage } from '@/lib/errors'
import { applyBlockingReviewPolicy } from '@/mastra/review/blocking-policy'
import { buildReviewContextPackage } from '@/mastra/review/context-package'
import { resolveDiffBaseRef } from '@/mastra/review/diff-base'
import { enforceFileInspection } from '@/mastra/review/inspection'
import {
  parseReviewOutputV2,
  ReviewOutputParseError,
  type ReviewOutputV2,
} from '@/mastra/review/schema'

export interface ReviewFeatureFlags {
  structuredFindingsPost: boolean
  dryRun: boolean
  structuralSignals: boolean
  bugHistory: boolean
}

export interface ReviewStepContextInput {
  mrIid: number
  title: string
  description: string
  labels: string[]
  sourceBranch: string
  targetBranch: string
  worktreePath: string
  reviewMode: 'initial' | 'update'
  previousReviewedSha: string | null
}

export const getReviewFeatureFlags = (project: ProjectConfig): ReviewFeatureFlags => ({
  structuredFindingsPost: project.review.flags.structured_findings_post,
  dryRun: project.review.flags.dry_run,
  structuralSignals: project.review.flags.structural_signals,
  bugHistory: project.review.flags.bug_history,
})

export const resolveReviewContext = async (
  project: ProjectConfig,
  input: Pick<
    ReviewStepContextInput,
    'mrIid' | 'worktreePath' | 'reviewMode' | 'previousReviewedSha' | 'targetBranch'
  >,
) => {
  const provider = createReviewProvider(project)
  const diffRefs = await provider.fetchDiffRefs(input.mrIid)
  const commitFetchWarnings = await ensureCommitsAvailable(project, [
    diffRefs.baseSha,
    ...(diffRefs.startSha ? [diffRefs.startSha] : []),
  ])
  const resolvedDiffBase = await resolveDiffBaseRef({
    worktreePath: input.worktreePath,
    reviewMode: input.reviewMode,
    previousReviewedSha: input.previousReviewedSha,
    targetBranch: input.targetBranch,
    diffRefs,
    refetchOrigin: async () => await refetchOrigin(project),
  })
  const diffBaseResolution = {
    ...resolvedDiffBase,
    warnings: [...commitFetchWarnings, ...resolvedDiffBase.warnings],
  }

  const contextPackage = await buildReviewContextPackage({
    worktreePath: input.worktreePath,
    targetBranch: input.targetBranch,
    baseRef: diffBaseResolution.baseRef,
  })

  return {
    contextPackage,
    diffBaseResolution,
  }
}

export interface EffectiveReviewAgentConfig {
  harness: ReviewAgentHarnessId
  model: string
  thinkingLevel: ReviewAgentThinkingLevel
  timeoutMs: number | undefined
}

export const getEffectiveReviewAgentConfig = (
  project: ProjectConfig,
): EffectiveReviewAgentConfig => {
  const agent = project.review.agent
  const isEnsemble = agent.harness === 'ensemble'

  return {
    harness: agent.harness,
    model: isEnsemble
      ? (agent.ensemble?.synthesizer_model ?? defaultEnsembleConfig.synthesizer_model)
      : (agent.model ?? project.review.llm.model),
    thinkingLevel: agent.thinking_level ?? project.review.llm.thinking_level,
    timeoutMs: agent.timeout_ms,
  }
}

type BaseReviewAgentHarnessId = Exclude<ReviewAgentHarnessId, 'ensemble'>

const createBaseReviewHarnesses = (): Record<BaseReviewAgentHarnessId, ReviewAgentHarness> => {
  const harnesses: Record<BaseReviewAgentHarnessId, ReviewAgentHarness> = {
    pi: {
      id: 'pi',
      invoke: async (config) => {
        const startTime = Date.now()
        const result = await invokePiReview({
          cwd: config.cwd,
          sessionDir: config.sessionDir,
          model: config.model,
          thinkingLevel: config.thinkingLevel,
          instructions: config.instructions,
          prompt: config.prompt,
          timeoutMs: config.timeoutMs,
          context7ApiKey: config.context7ApiKey,
          toolMode: config.toolMode,
          signal: config.signal,
        })

        return {
          harness: 'pi',
          model: config.model,
          success: result.success,
          output: result.output,
          durationMs: Date.now() - startTime,
          sessionFile: result.sessionFile,
          error: result.error,
          authFailed: result.authFailed,
        }
      },
    },
    codex: {
      id: 'codex',
      invoke: invokeCodexReview,
    },
    opencode: {
      id: 'opencode',
      invoke: async (config) => {
        const result = await invokeOpenCodeReview({
          cwd: config.cwd,
          model: config.model,
          thinkingLevel: config.thinkingLevel,
          instructions: config.instructions,
          prompt: config.prompt,
          timeoutMs: config.timeoutMs,
          signal: config.signal,
        })

        return {
          harness: 'opencode',
          model: config.model,
          success: result.success,
          output: result.output,
          durationMs: result.durationMs,
          error: result.error,
          authFailed: result.authFailed,
        }
      },
    },
  }

  return harnesses
}

const createDefaultReviewHarnesses = (
  project: ProjectConfig,
): Record<ReviewAgentHarnessId, ReviewAgentHarness> => {
  const baseHarnesses = createBaseReviewHarnesses()

  return {
    ...baseHarnesses,
    ensemble: createEnsembleReviewHarness({
      config: project.review.agent.ensemble,
      harnesses: baseHarnesses,
    }),
  }
}

interface InvokeReviewAgentParams {
  project: ProjectConfig
  worktreePath: string
  sessionDir: string
  instructions: string
  prompt: string
  changedFiles: string[]
  context7ApiKey: string | null
  expectedPriorBlockerIds?: readonly string[]
  harnesses?: Partial<Record<ReviewAgentHarnessId, ReviewAgentHarness>>
  signal?: AbortSignal
}

type ReviewAgentHarnesses = Record<ReviewAgentHarnessId, ReviewAgentHarness>

type RunReviewAgent = (
  prompt: string,
  options?: { toolMode?: 'read-only' | 'none' },
) => Promise<ReviewAgentResult>

const buildFinalOutputRetryPrompt = (prompt: string, error: ReviewOutputParseError): string =>
  [
    prompt,
    '',
    'Final output retry required.',
    `Your previous response did not end with a valid review JSON payload: ${error.message}`,
    error.outputExcerpt ? `Previous output excerpt: ${error.outputExcerpt}` : '',
    'Do not read any more files and do not run any more tools.',
    'Return only the final JSON object that matches the required review schema.',
  ]
    .filter(Boolean)
    .join('\n')

const createComparisonResultPromise = (
  params: InvokeReviewAgentParams,
  harnesses: ReviewAgentHarnesses,
  comparisonAbortController: AbortController,
): Promise<ReviewAgentResult | null> => {
  const comparisonRunStart = Date.now()
  const comparisonHarnessId = params.project.review.comparison.harness
  const comparisonHarness = harnesses[comparisonHarnessId]
  const comparisonPrompt =
    comparisonHarnessId === 'opencode'
      ? `${params.prompt}\n\nUse subagents in parallel for context gathering.`
      : params.prompt
  const comparisonResultPromise: Promise<ReviewAgentResult | null> = params.project.review
    .comparison.enabled
    ? comparisonHarness
      ? comparisonHarness
          .invoke({
            cwd: params.worktreePath,
            sessionDir: resolve(params.sessionDir, `comparison-${comparisonHarnessId}`),
            model: params.project.review.comparison.model ?? params.project.review.llm.model,
            thinkingLevel:
              params.project.review.comparison.thinking_level ??
              params.project.review.llm.thinking_level,
            instructions: params.instructions,
            prompt: comparisonPrompt,
            expectedPriorBlockerIds: params.expectedPriorBlockerIds,
            timeoutMs: params.project.review.comparison.timeout_ms,
            context7ApiKey: params.context7ApiKey,
            signal: comparisonAbortController.signal,
          })
          .catch((error) => ({
            harness: comparisonHarnessId,
            model: params.project.review.comparison.model ?? params.project.review.llm.model,
            success: false,
            output: '',
            durationMs: Date.now() - comparisonRunStart,
            error: toErrorMessage(error),
          }))
      : Promise.resolve({
          harness: comparisonHarnessId,
          model: params.project.review.comparison.model ?? params.project.review.llm.model,
          success: false,
          output: '',
          durationMs: Date.now() - comparisonRunStart,
          error: `Review comparison harness not available: ${comparisonHarnessId}`,
        })
    : Promise.resolve(null)

  return comparisonResultPromise
}

const parseOrRetryFinalOutput = async (input: {
  reviewResult: ReviewAgentResult
  prompt: string
  runReview: RunReviewAgent
  harness: ReviewAgentHarnessId
  expectedPriorBlockerIds: readonly string[]
}): Promise<{
  reviewResult: ReviewAgentResult
  validatedReview: ReviewOutputV2
}> => {
  try {
    return {
      reviewResult: input.reviewResult,
      validatedReview: applyBlockingReviewPolicy(
        parseReviewOutputV2(input.reviewResult.output),
        input.expectedPriorBlockerIds,
      ),
    }
  } catch (error) {
    if (!(error instanceof ReviewOutputParseError)) {
      throw error
    }

    if (input.harness !== 'pi') {
      throw new Error(
        `${input.harness} review returned invalid final output and does not support no-tool retry: ${error.message}`,
      )
    }

    console.warn(`[review] invalid final output, retrying once without tools: ${error.message}`)

    const retryResult = await input.runReview(buildFinalOutputRetryPrompt(input.prompt, error), {
      toolMode: 'none',
    })
    if (!retryResult.success) {
      throw new Error(`${input.harness} review final-output retry failed: ${retryResult.error}`)
    }

    try {
      return {
        reviewResult: retryResult,
        validatedReview: applyBlockingReviewPolicy(
          parseReviewOutputV2(retryResult.output),
          input.expectedPriorBlockerIds,
        ),
      }
    } catch (retryError) {
      if (retryError instanceof ReviewOutputParseError) {
        throw new Error(
          `${input.harness} review returned invalid final output after retry: ${retryError.message}`,
        )
      }
      throw retryError
    }
  }
}

export const invokeReviewAgent = async (params: InvokeReviewAgentParams) => {
  const defaultHarnesses = createDefaultReviewHarnesses(params.project)
  const harnesses = { ...defaultHarnesses, ...params.harnesses }
  const primaryConfig = getEffectiveReviewAgentConfig(params.project)
  const primaryHarness = harnesses[primaryConfig.harness]

  if (!primaryHarness) {
    throw new Error(`Review harness not available: ${primaryConfig.harness}`)
  }

  const comparisonAbortController = new AbortController()
  const abortComparison = () => comparisonAbortController.abort()
  params.signal?.addEventListener('abort', abortComparison, { once: true })
  if (params.signal?.aborted) {
    abortComparison()
  }
  const comparisonResultPromise = createComparisonResultPromise(
    params,
    harnesses,
    comparisonAbortController,
  )

  const runReview: RunReviewAgent = async (prompt, options) =>
    await primaryHarness.invoke({
      cwd: params.worktreePath,
      sessionDir: params.sessionDir,
      model: primaryConfig.model,
      thinkingLevel: primaryConfig.thinkingLevel,
      instructions: params.instructions,
      prompt,
      changedFiles: params.changedFiles,
      expectedPriorBlockerIds: params.expectedPriorBlockerIds,
      timeoutMs: primaryConfig.timeoutMs,
      context7ApiKey: params.context7ApiKey,
      toolMode: options?.toolMode,
      signal: params.signal,
    })

  try {
    let reviewResult = await runReview(params.prompt)
    if (!reviewResult.success) {
      throw new Error(`${primaryConfig.harness} review failed: ${reviewResult.error}`)
    }

    const inspectionResult = await enforceFileInspection({
      reviewResult,
      worktreePath: params.worktreePath,
      changedFiles: params.changedFiles,
      prompt: params.prompt,
      retryReview: runReview,
    })

    reviewResult = inspectionResult.reviewResult
    const finalOutput = await parseOrRetryFinalOutput({
      reviewResult,
      prompt: params.prompt,
      runReview,
      harness: primaryConfig.harness,
      expectedPriorBlockerIds: params.expectedPriorBlockerIds ?? [],
    })
    reviewResult = finalOutput.reviewResult

    const comparisonExecutionResult = await comparisonResultPromise

    return {
      reviewResult,
      validatedReview: finalOutput.validatedReview,
      inspectionResult,
      comparisonExecutionResult,
    }
  } catch (error) {
    comparisonAbortController.abort()
    await comparisonResultPromise
    throw error
  } finally {
    params.signal?.removeEventListener('abort', abortComparison)
  }
}
