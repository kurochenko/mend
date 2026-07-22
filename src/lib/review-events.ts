import { z } from 'zod'

export const mrContextSchema = z.object({
  projectKey: z.string(),
  mrIid: z.number(),
  title: z.string(),
  description: z.string(),
  labels: z.array(z.string()),
  sourceBranch: z.string(),
  targetBranch: z.string(),
  url: z.string(),
})

export type MrReviewRequestEvent = z.infer<typeof mrContextSchema>

export const asMrReviewRequestEvent = (value: unknown): MrReviewRequestEvent | null => {
  const parsed = mrContextSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}
