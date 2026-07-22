import { z } from 'zod'
import type { ReviewAgentHarnessId } from '@/agents/review-harness'

export const reviewAgentHarnessIdSchema = z.enum(['pi', 'codex', 'opencode', 'ensemble'])

export const featureFlagsSchema = z.object({
  promptTemplatesV2: z.boolean(),
  schemaV2: z.boolean(),
  structuredFindingsPost: z.boolean(),
  dryRun: z.boolean(),
  structuralSignals: z.boolean().optional().default(true),
  bugHistory: z.boolean().optional().default(true),
})

export type FeatureFlags = z.infer<typeof featureFlagsSchema>

export const reviewDiagnosticsSchema = z.object({
  reviewMode: z.enum(['initial', 'update']),
  previousReviewedSha: z.string().nullable(),
  diffBaseRef: z.string(),
  changedFileCount: z.number().int().nonnegative(),
  diffExcerptChars: z.number().int().nonnegative(),
  diffTruncated: z.boolean(),
  intentClassifierModel: z.string(),
  intentClassifierDurationMs: z.number().int().nonnegative(),
  intentClassifierFailure: z.string().nullable(),
  intentSecondaryIntents: z.array(
    z.enum(['style_refactor', 'feature', 'bugfix', 'security_sensitive', 'mixed']),
  ),
  agent: z
    .object({
      harness: reviewAgentHarnessIdSchema,
      model: z.string(),
      durationMs: z.number().int().nonnegative().nullable(),
      sessionFile: z.string().optional(),
    })
    .optional()
    .default({ harness: 'pi', model: 'unknown', durationMs: null }),
  inspection: z.object({
    files: z.array(z.string()),
    changedFiles: z.array(z.string()),
    changedFileCount: z.number().int().nonnegative(),
    changedFileCoverage: z.number().min(0).max(1),
  }),
  structuralSignals: z.unknown().nullable().optional().default(null),
  contextPackageDiagnostics: z
    .array(
      z.object({
        analyzer: z.string(),
        stage: z.string(),
        message: z.string(),
      }),
    )
    .optional()
    .default([]),
  templateWarnings: z.array(z.string()),
})

export type ReviewDiagnostics = z.infer<typeof reviewDiagnosticsSchema>

export interface BuildReviewDiagnosticsInput {
  reviewMode: 'initial' | 'update'
  previousReviewedSha: string | null
  diffBaseRef: string
  changedFileCount: number
  diffExcerptChars: number
  diffTruncated: boolean
  intentClassifierModel: string
  intentClassifierDurationMs: number
  intentClassifierFailure: string | null
  intentSecondaryIntents: ReviewDiagnostics['intentSecondaryIntents']
  agentHarness: ReviewAgentHarnessId
  agentModel: string
  templateWarnings: string[]
}

export const buildReviewDiagnostics = (input: BuildReviewDiagnosticsInput): ReviewDiagnostics => ({
  reviewMode: input.reviewMode,
  previousReviewedSha: input.previousReviewedSha,
  diffBaseRef: input.diffBaseRef,
  changedFileCount: input.changedFileCount,
  diffExcerptChars: input.diffExcerptChars,
  diffTruncated: input.diffTruncated,
  intentClassifierModel: input.intentClassifierModel,
  intentClassifierDurationMs: input.intentClassifierDurationMs,
  intentClassifierFailure: input.intentClassifierFailure,
  intentSecondaryIntents: input.intentSecondaryIntents,
  agent: {
    harness: input.agentHarness,
    model: input.agentModel,
    durationMs: null,
  },
  inspection: {
    files: [],
    changedFiles: [],
    changedFileCount: 0,
    changedFileCoverage: 0,
  },
  contextPackageDiagnostics: [],
  templateWarnings: input.templateWarnings,
})

export interface ReviewAgentDiagnosticsInput {
  harness: ReviewAgentHarnessId
  model: string
  durationMs: number
  sessionFile?: string
}

export const applyReviewAgentDiagnostics = (
  diagnostics: ReviewDiagnostics,
  agent: ReviewAgentDiagnosticsInput,
): ReviewDiagnostics => ({
  ...diagnostics,
  agent: {
    harness: agent.harness,
    model: agent.model,
    durationMs: agent.durationMs,
    ...(agent.sessionFile ? { sessionFile: agent.sessionFile } : {}),
  },
})

export interface InspectionDiagnostics {
  files: string[]
  changedFiles: string[]
  changedFileCount: number
  changedFileCoverage: number
}

export const applyInspectionDiagnostics = (
  diagnostics: ReviewDiagnostics,
  inspection: InspectionDiagnostics,
): ReviewDiagnostics => ({
  ...diagnostics,
  inspection,
})
