import { z } from 'zod'
import { reviewOutputV2Schema } from '@/mastra/review/schema'

export const comparisonResultPayloadSchema = z.object({
  harness: z.enum(['pi', 'codex', 'opencode', 'ensemble']),
  status: z.enum(['success', 'failed']),
  durationMs: z.number().int().nonnegative(),
  error: z.string().optional(),
  review: reviewOutputV2Schema.optional(),
})

export const comparisonResultSchema = comparisonResultPayloadSchema.nullable()

export type ComparisonResultPayload = z.infer<typeof comparisonResultPayloadSchema>
export type ComparisonResult = z.infer<typeof comparisonResultSchema>
