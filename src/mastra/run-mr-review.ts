import type { Mastra } from '@mastra/core'
import type { WorkflowResult } from '@mastra/core/workflows'
import { getProject } from '@/config'
import {
  completeReviewRun,
  createReviewRun,
  failReviewRun,
  type ReviewRunSource,
} from '@/db/review-runs'
import { removeWorktree } from '@/integrations/repo'
import { toErrorMessage } from '@/lib/errors'
import { type MrReviewInput, mrReviewInputSchema } from '@/lib/review-run-input'
import { getEffectiveReviewAgentConfig } from '@/mastra/review/review-pipeline'
import { type PostStepOutput, postStepOutputSchema } from '@/mastra/review/run-result'

type MrReviewWorkflowResult = WorkflowResult<any, any, any, any>

interface ExecuteMrReviewParams {
  mastra: Mastra
  input: MrReviewInput
  source: ReviewRunSource
  webhookPayload?: unknown
}

interface ExecuteMrReviewResult {
  reviewRunId: string
  workflowRunId: string
  workflowResult: MrReviewWorkflowResult
  output?: PostStepOutput
  failure?: ReviewFailure
}

export type ReviewFailurePhase = 'setup' | 'review' | 'post' | 'workflow'
export type ReviewFailureCategory = 'git' | 'provider' | 'harness' | 'workflow'

export interface ReviewFailure {
  phase: ReviewFailurePhase
  category: ReviewFailureCategory
  message: string
}

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  return value as Record<string, unknown>
}

const extractErrorMessage = (value: unknown): string | null => {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value
  }

  const record = asRecord(value)
  if (!record) {
    return null
  }

  if (typeof record.message === 'string' && record.message.trim().length > 0) {
    return record.message
  }

  return extractErrorMessage(record.error)
}

const phaseFromStep = (step: string): ReviewFailurePhase => {
  if (step === 'setup' || step === 'review' || step === 'post') {
    return step
  }
  return 'workflow'
}

const categoryFromFailure = (phase: ReviewFailurePhase, message: string): ReviewFailureCategory => {
  if (/github|gitlab|provider|api/i.test(message)) {
    return 'provider'
  }
  if (/git\b|diff|ref|head|commit|worktree|symmetric/i.test(message) || phase === 'setup') {
    return 'git'
  }
  if (/harness|agent|codex|opencode|pi\b|review failed/i.test(message) || phase === 'review') {
    return 'harness'
  }
  return 'workflow'
}

const buildFailure = (phase: ReviewFailurePhase, message: string): ReviewFailure => ({
  phase,
  category: categoryFromFailure(phase, message),
  message,
})

export const extractWorkflowFailure = (workflowResult: unknown): ReviewFailure | null => {
  const workflow = asRecord(workflowResult)
  if (!workflow || workflow.status === 'success') {
    return null
  }

  const steps = asRecord(workflow.steps)
  if (steps) {
    for (const [stepName, stepValue] of Object.entries(steps)) {
      const step = asRecord(stepValue)
      if (!step) {
        continue
      }

      const hasFailure = step.status === 'failed' || step.error !== undefined
      if (!hasFailure) {
        continue
      }

      const message =
        extractErrorMessage(step.error) ??
        extractErrorMessage(step.result) ??
        (step.status === 'failed' ? `Step ${stepName} failed` : null)
      if (message) {
        return buildFailure(phaseFromStep(stepName), message)
      }
    }
  }

  const message =
    extractErrorMessage(workflow.error) ??
    extractErrorMessage(workflow.result) ??
    `Workflow status: ${typeof workflow.status === 'string' ? workflow.status : 'failed'}`
  return buildFailure('workflow', message)
}

export const formatPublicReviewFailure = (failure: ReviewFailure): string =>
  `${failure.phase === 'post' ? 'Review publication failed' : 'Review failed'} during ${failure.phase} (${failure.category})`

export class ReviewExecutionError extends Error {
  readonly reviewRunId: string
  readonly failure: ReviewFailure

  constructor(reviewRunId: string, failure: ReviewFailure) {
    super(failure.message)
    this.name = 'ReviewExecutionError'
    this.reviewRunId = reviewRunId
    this.failure = failure
  }
}

export const applyReviewRunSourceOverrides = (
  input: MrReviewInput,
  source: ReviewRunSource,
): MrReviewInput => (source === 'replay_benchmark' ? { ...input, forceDryRun: true } : input)

export const executeMrReview = async (
  params: ExecuteMrReviewParams,
): Promise<ExecuteMrReviewResult> => {
  const parsedInput = mrReviewInputSchema.parse(params.input)
  const project = getProject(parsedInput.projectKey)

  const reviewRunId = crypto.randomUUID()
  const input: MrReviewInput = {
    ...applyReviewRunSourceOverrides(parsedInput, params.source),
    reviewRunId,
  }
  const startedAt = Date.now()
  const workflow = params.mastra.getWorkflow('mr-review')
  const run = await workflow.createRun()
  const workflowRunId = run.runId

  await createReviewRun({
    id: reviewRunId,
    projectKey: input.projectKey,
    mrIid: input.mrIid,
    commitSha: input.commitSha,
    model: getEffectiveReviewAgentConfig(project).model,
    source: params.source,
    webhookPayload: params.webhookPayload,
    input,
    workflowRunId,
  })

  try {
    const workflowResult = await run.start({ inputData: input })
    const durationMs = Date.now() - startedAt

    if (workflowResult.status === 'success') {
      const output = postStepOutputSchema.parse(workflowResult.result)
      await completeReviewRun({
        id: reviewRunId,
        commitSha: output.commitSha,
        workflowRunId,
        durationMs,
        result: output,
        comparisonResult: output.comparisonResult,
      })
      return {
        reviewRunId,
        workflowRunId,
        workflowResult,
        output,
      }
    }

    const failure =
      extractWorkflowFailure(workflowResult) ??
      buildFailure('workflow', `Workflow status: ${workflowResult.status}`)
    await failReviewRun({
      id: reviewRunId,
      commitSha: input.commitSha,
      workflowRunId,
      durationMs,
      error: failure.message,
      result: workflowResult,
    })

    return {
      reviewRunId,
      workflowRunId,
      workflowResult,
      failure,
    }
  } catch (error) {
    const durationMs = Date.now() - startedAt
    const failure = buildFailure('workflow', toErrorMessage(error))
    await failReviewRun({
      id: reviewRunId,
      commitSha: input.commitSha,
      workflowRunId,
      durationMs,
      error: failure.message,
    })
    throw new ReviewExecutionError(reviewRunId, failure)
  } finally {
    await removeWorktree(project, input.mrIid)
  }
}
