import { z } from 'zod'
import { comparisonResultSchema } from '@/mastra/review/comparison'
import { featureFlagsSchema, reviewDiagnosticsSchema } from '@/mastra/review/diagnostics'
import {
  reviewFindingSchema,
  reviewInlineCommentSchema,
  reviewOutputV2Schema,
} from '@/mastra/review/schema'
import { intentMetadataSchema, stepPassthroughSchema } from '@/mastra/review/step-schemas'
import { reviewModeContextSchema } from '@/lib/review-run-input'

export const activeReviewMemoryEntrySchema = z.object({
  scope: z.string(),
  status: z.string(),
  matchPath: z.string().nullable(),
  matchLine: z.number().int().nullable(),
  instruction: z.string(),
})

export const activeReviewMemoryEntriesSchema = z
  .array(activeReviewMemoryEntrySchema)
  .optional()
  .default([])

export const postDiagnosticsSchema = z.object({
  findingsCount: z.number().int().nonnegative(),
  outOfScopeFindingCount: z.number().int().nonnegative(),
  inlineCommentCount: z.number().int().nonnegative(),
  outOfScopeInlineCount: z.number().int().nonnegative(),
  postedInlineCount: z.number().int().nonnegative(),
  preExistingDraftCount: z.number().int().nonnegative(),
  recoveredDraftCount: z.number().int().nonnegative(),
  draftRecoveryAction: z.enum(['none', 'reused', 'cleaned']),
  skippedInlineReasons: z.record(z.number().int().nonnegative()),
  resolvedThreadCount: z.number().int().nonnegative().default(0),
  partiallyFixedThreadCount: z.number().int().nonnegative().default(0),
  unmatchedVerdictCount: z.number().int().nonnegative().default(0),
  persistedFindingCount: z.number().int().nonnegative().default(0),
  dedupedExistingThreadCount: z.number().int().nonnegative().default(0),
  suppressedResolvedThreadCount: z.number().int().nonnegative().default(0),
  automaticFixBatchStatus: z
    .enum(['disabled', 'no_findings', 'duplicate', 'loop_limit', 'queued'])
    .nullable()
    .default(null),
})

export const postedThreadRefSchema = z.object({
  providerThreadId: z.string().nullable(),
  providerMessageId: z.string().nullable(),
})

export const threadedFindingSchema = reviewFindingSchema.extend({
  providerThreadId: z.string().nullable(),
  providerMessageId: z.string().nullable(),
})

export const threadedInlineCommentSchema = reviewInlineCommentSchema.extend({
  providerThreadId: z.string().nullable(),
  providerMessageId: z.string().nullable(),
})

export const postStepInputSchema = reviewOutputV2Schema
  .merge(stepPassthroughSchema)
  .merge(reviewModeContextSchema)
  .merge(intentMetadataSchema)
  .extend({
    featureFlags: featureFlagsSchema,
    reviewDiagnostics: reviewDiagnosticsSchema,
    comparisonResult: comparisonResultSchema,
    activeReviewMemoryEntries: activeReviewMemoryEntriesSchema,
  })

export const postStepOutputSchema = postStepInputSchema
  .omit({ worktreePath: true, targetBranch: true })
  .extend({
    postDiagnostics: postDiagnosticsSchema,
    postedInlineComments: z.array(postedThreadRefSchema).optional().default([]),
    postedFindings: z.array(postedThreadRefSchema).optional().default([]),
    threadedFindings: z.array(threadedFindingSchema).optional().default([]),
    threadedInlineComments: z.array(threadedInlineCommentSchema).optional().default([]),
    posted: z.number(),
    skipped: z.number(),
    reviewNumber: z.number().int().positive().default(1),
    summaryNoteId: z.number(),
  })

export type PostedThreadRef = z.infer<typeof postedThreadRefSchema>
export type PostedInlineComment = PostedThreadRef
export type PostedFinding = PostedThreadRef
export type ThreadedFinding = z.infer<typeof threadedFindingSchema>
export type ThreadedInlineComment = z.infer<typeof threadedInlineCommentSchema>
export type PostStepInput = z.infer<typeof postStepInputSchema>
export type PostStepOutput = z.infer<typeof postStepOutputSchema>
