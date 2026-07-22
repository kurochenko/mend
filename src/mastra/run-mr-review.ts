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
import { mrReviewInputSchema, type MrReviewInput } from '@/lib/review-run-input'
import { postStepOutputSchema, type PostStepOutput } from '@/mastra/review/run-result'
import { getEffectiveReviewAgentConfig } from '@/mastra/review/review-pipeline'

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

    await failReviewRun({
      id: reviewRunId,
      commitSha: input.commitSha,
      workflowRunId,
      durationMs,
      error: `Workflow status: ${workflowResult.status}`,
      result: workflowResult,
    })

    return {
      reviewRunId,
      workflowRunId,
      workflowResult,
    }
  } catch (error) {
    const durationMs = Date.now() - startedAt
    await failReviewRun({
      id: reviewRunId,
      commitSha: input.commitSha,
      workflowRunId,
      durationMs,
      error: toErrorMessage(error),
    })
    throw error
  } finally {
    await removeWorktree(project, input.mrIid)
  }
}
