import { z } from 'zod'

export const stepPassthroughSchema = z.object({
  projectKey: z.string(),
  mrIid: z.number(),
  reviewRunId: z.string(),
  url: z.string(),
  worktreePath: z.string(),
  targetBranch: z.string(),
  commitSha: z.string(),
})
