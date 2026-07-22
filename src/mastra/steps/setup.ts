import { createStep } from '@mastra/core/workflows'
import { z } from 'zod'
import { getProject } from '@/config'
import { ensureClone, createWorktree, getWorktreeHeadSha } from '@/integrations/repo'
import { mrContextSchema } from '@/lib/review-events'
import { mrReviewInputSchema, reviewModeContextSchema } from '@/lib/review-run-input'

const setupOutputSchema = mrContextSchema.merge(reviewModeContextSchema).extend({
  reviewRunId: z.string(),
  worktreePath: z.string(),
  commitSha: z.string(),
  context7ApiKey: z.string().nullable(),
  forceDryRun: z.boolean().optional(),
})

export const setupStep = createStep({
  id: 'setup',
  inputSchema: mrReviewInputSchema,
  outputSchema: setupOutputSchema,
  execute: async ({ inputData }) => {
    const project = getProject(inputData.projectKey)

    await ensureClone(project)
    const worktreePath = await createWorktree(
      project,
      inputData.mrIid,
      inputData.sourceBranch,
      inputData.commitSha,
    )
    const commitSha = await getWorktreeHeadSha(worktreePath)

    return {
      worktreePath,
      projectKey: inputData.projectKey,
      mrIid: inputData.mrIid,
      reviewRunId: inputData.reviewRunId ?? crypto.randomUUID(),
      title: inputData.title,
      description: inputData.description,
      labels: inputData.labels,
      sourceBranch: inputData.sourceBranch,
      targetBranch: inputData.targetBranch,
      url: inputData.url,
      commitSha,
      reviewMode: inputData.reviewMode,
      previousReviewedSha: inputData.previousReviewedSha,
      previousRunId: inputData.previousRunId,
      context7ApiKey: project.tools.context7.api_key ?? null,
      forceDryRun: inputData.forceDryRun,
    }
  },
})
