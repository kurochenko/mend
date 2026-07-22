import { z } from 'zod'
import { mrContextSchema } from '@/lib/review-events'

export const reviewModeEnum = z.enum(['initial', 'update'])

export const reviewModeContextSchema = z.object({
  reviewMode: reviewModeEnum,
  previousReviewedSha: z.string().nullable(),
  previousRunId: z.string().nullable().default(null),
})

export const mrReviewInputSchema = mrContextSchema.extend({
  reviewRunId: z.string().optional(),
  labels: z.array(z.string()).default([]),
  commitSha: z.string().optional(),
  reviewMode: reviewModeEnum.default('initial'),
  previousReviewedSha: z.string().nullable().default(null),
  previousRunId: z.string().nullable().default(null),
  forceDryRun: z.boolean().optional(),
})

export type ReviewModeContext = z.infer<typeof reviewModeContextSchema>
export type MrReviewInput = z.infer<typeof mrReviewInputSchema>
