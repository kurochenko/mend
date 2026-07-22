import { z } from 'zod'
import { reviewIntents } from '@/mastra/review/intents'

export const intentEnum = z.enum(reviewIntents)

export const templateSourceEnum = z.enum(['config', 'label', 'classifier', 'fallback'])

export const intentMetadataSchema = z.object({
  reviewIntent: intentEnum,
  reviewIntentConfidence: z.number(),
  reviewIntentRationale: z.array(z.string()),
  reviewTemplateId: intentEnum,
  reviewTemplateSource: templateSourceEnum,
})

export const stepPassthroughSchema = z.object({
  projectKey: z.string(),
  mrIid: z.number(),
  reviewRunId: z.string(),
  url: z.string(),
  worktreePath: z.string(),
  targetBranch: z.string(),
  commitSha: z.string(),
})

export type IntentMetadata = z.infer<typeof intentMetadataSchema>
