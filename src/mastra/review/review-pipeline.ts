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
import { toErrorMessage } from '@/lib/errors'
import { applyBlockingReviewPolicy } from '@/mastra/review/blocking-policy'
import { buildReviewContextPackage } from '@/mastra/review/context-package'
import { resolveDiffBaseRef } from '@/mastra/review/diff-base'
import { enforceFileInspection } from '@/mastra/review/inspection'
import { classifyMrIntentWithLlm, type LlmIntentResult } from '@/mastra/review/intent-llm'
import {
  parseReviewOutputV2,
  ReviewOutputParseError,
  type ReviewOutputV2,
} from '@/mastra/review/schema'
import type { TemplateSelectionResult } from '@/mastra/review/template-selection'

export interface ReviewFeatureFlags {
  promptTemplatesV2: boolean
  schemaV2: boolean
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
  promptTemplatesV2: project.review.flags.prompt_templates_v2,
  schemaV2: project.review.flags.schema_v2,
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
  const diffBaseResolution = await resolveDiffBaseRef({
    worktreePath: input.worktreePath,
    reviewMode: input.reviewMode,
    previousReviewedSha: input.previousReviewedSha,
    targetBranch: input.targetBranch,
    diffRefs,
  })

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

export const classifyIntentWithFallback = async (
  project: ProjectConfig,
  input: Pick<
    ReviewStepContextInput,
    'title' | 'description' | 'labels' | 'sourceBranch' | 'targetBranch' | 'worktreePath'
  >,
  changedFiles: string[],
  sessionDir: string,
): Promise<{
  intentResult: LlmIntentResult
  intentClassifierFailure: string | null
  intentClassifierDurationMs: number
}> => {
  const intentStart = Date.now()
  let intentClassifierFailure: string | null = null
  let intentResult: LlmIntentResult

  try {
    intentResult = await classifyMrIntentWithLlm(
      {
        title: input.title,
        description: input.description,
        labels: input.labels,
        sourceBranch: input.sourceBranch,
        targetBranch: input.targetBranch,
        changedFiles,
      },
      {
        cwd: input.worktreePath,
        sessionDir: resolve(sessionDir, 'intent'),
        harness: project.review.intent.harness,
        model: project.review.intent.model,
        thinkingLevel: project.review.intent.thinking_level,
        timeoutMs: project.review.intent.timeout_ms,
      },
    )
  } catch (error) {
    const message = toErrorMessage(error)
    if (project.review.intent.failure_policy === 'fail') {
      throw error
    }
    intentClassifierFailure = message
    intentResult = {
      intent: 'mixed',
      confidence: 0,
      rationale: ['intent classifier failed, using mixed template fallback', message],
      secondaryIntents: [],
    }
    console.warn(`[review] intent classifier failed, fallback=mixed reason=${message}`)
  }

  return {
    intentResult,
    intentClassifierFailure,
    intentClassifierDurationMs: Date.now() - intentStart,
  }
}

export const selectEffectiveTemplate = (
  featureFlags: ReviewFeatureFlags,
  templateResult: TemplateSelectionResult,
): TemplateSelectionResult => {
  if (featureFlags.promptTemplatesV2) {
    return templateResult
  }

  return {
    templateId: 'mixed',
    source: 'fallback',
    warnings: [...templateResult.warnings, 'prompt templates v2 disabled by project config'],
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
}

type ReviewAgentHarnesses = Record<ReviewAgentHarnessId, ReviewAgentHarness>

type RunReviewAgent = (
  prompt: string,
  options?: { toolMode?: 'full' | 'none' },
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
      timeoutMs: primaryConfig.timeoutMs,
      context7ApiKey: params.context7ApiKey,
      toolMode: options?.toolMode,
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
  }
}
