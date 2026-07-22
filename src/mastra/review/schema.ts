import { z } from 'zod'
import { extractJson } from '@/lib/json'
import { reviewTemplateIds } from '@/mastra/review/intents'

export const reviewSeveritySchema = z.enum(['bug', 'security', 'performance', 'suggestion'])

const fileLineEvidenceSchema = z.object({
  type: z.literal('file_line'),
  file: z.string().min(1),
  line: z.number().int().positive(),
  note: z.string().optional(),
})

const symbolEvidenceSchema = z.object({
  type: z.literal('symbol'),
  value: z.string().min(1),
})

const commandOutputEvidenceSchema = z.object({
  type: z.literal('command_output'),
  command: z.string().min(1),
  excerpt: z.string().min(1),
})

export const reviewEvidenceSchema = z.discriminatedUnion('type', [
  fileLineEvidenceSchema,
  symbolEvidenceSchema,
  commandOutputEvidenceSchema,
])

export const reviewFindingSchema = z.object({
  id: z.string().min(1),
  category: z.enum([
    'correctness',
    'architecture',
    'duplication',
    'convention',
    'dead_code',
    'performance',
    'security',
    'testing',
  ]),
  severity: reviewSeveritySchema,
  actionability: z.enum(['required', 'recommended', 'optional']),
  scope: z.enum(['single_file', 'cross_file', 'project']),
  title: z.string().min(1),
  body: z.string().min(1),
  files: z.array(z.string().min(1)).optional(),
  evidence: z.array(reviewEvidenceSchema).min(1),
})

export const reviewInlineCommentSchema = z.object({
  file: z.string().min(1),
  line: z.number().int().positive(),
  severity: reviewSeveritySchema,
  body: z.string().min(1),
  suggestion: z.string().nullable().optional(),
})

export const reviewMetaSchema = z.object({
  templateId: z.enum(reviewTemplateIds),
  intent: z.enum(reviewTemplateIds),
  confidence: z.number().min(0).max(1),
  selectionSource: z.enum(['config', 'label', 'classifier', 'fallback']),
})

export const resolutionVerdictSchema = z.object({
  previousFindingId: z.string().min(1),
  status: z.enum(['fixed', 'not_fixed', 'partially_fixed', 'cannot_determine']),
  explanation: z.string().min(1),
})

export const reviewOutputV2Schema = z.object({
  version: z.literal('v2'),
  assessment: z.enum(['approve', 'request_changes', 'needs_discussion']),
  summary: z.string().min(1),
  findings: z.array(reviewFindingSchema),
  inlineComments: z.array(reviewInlineCommentSchema),
  resolutionVerdicts: z.array(resolutionVerdictSchema).optional().default([]),
  meta: reviewMetaSchema.optional(),
})

export type ReviewOutputV2 = z.infer<typeof reviewOutputV2Schema>
export type ReviewFinding = z.infer<typeof reviewFindingSchema>
export type ReviewInlineComment = z.infer<typeof reviewInlineCommentSchema>
export type ResolutionVerdict = z.infer<typeof resolutionVerdictSchema>

const summarizeOutput = (output: string): string => {
  const normalized = output.trim().replace(/\s+/g, ' ')
  if (normalized.length <= 240) {
    return normalized
  }

  return `${normalized.slice(0, 240)}...`
}

const summarizeZodIssues = (error: z.ZodError): string =>
  error.issues
    .slice(0, 5)
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '<root>'
      return `${path}: ${issue.message}`
    })
    .join('; ')

export class ReviewOutputParseError extends Error {
  constructor(
    message: string,
    readonly outputExcerpt: string,
  ) {
    super(message)
    this.name = 'ReviewOutputParseError'
  }
}

export const parseReviewOutputV2 = (output: string): ReviewOutputV2 => {
  let parsed: unknown

  try {
    parsed = extractJson(output)
  } catch (error) {
    throw new ReviewOutputParseError(
      `Review output is missing a final JSON object: ${error instanceof Error ? error.message : String(error)}`,
      summarizeOutput(output),
    )
  }

  const result = reviewOutputV2Schema.safeParse(parsed)
  if (!result.success) {
    throw new ReviewOutputParseError(
      `Review output JSON does not match schema: ${summarizeZodIssues(result.error)}`,
      summarizeOutput(output),
    )
  }

  return result.data
}
