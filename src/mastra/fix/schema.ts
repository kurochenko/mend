import { z } from 'zod'
import { extractJson } from '@/lib/json'

export const fixerCheckResultSchema = z.object({
  command: z.string().min(1),
  status: z.enum(['passed', 'failed', 'skipped']),
  summary: z.string().min(1),
})

export const fixedFindingSchema = z.object({
  id: z.string().min(1),
  summary: z.string().min(1),
})

export const notFixedFindingSchema = z.object({
  id: z.string().min(1),
  reason: z.string().min(1),
})

export const fixerOutputSchema = z.object({
  version: z.literal('fixer-v1'),
  summary: z.string().min(1),
  fixedFindings: z.array(fixedFindingSchema),
  notFixedFindings: z.array(notFixedFindingSchema),
  changedFiles: z.array(z.string().min(1)),
  checksRun: z.array(fixerCheckResultSchema),
  errors: z.array(z.string().min(1)).default([]),
})

export type FixerOutput = z.infer<typeof fixerOutputSchema>

const summarizeZodIssues = (error: z.ZodError): string =>
  error.issues
    .slice(0, 5)
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '<root>'
      return `${path}: ${issue.message}`
    })
    .join('; ')

const outputExcerpt = (output: string): string => {
  const normalized = output.trim().replace(/\s+/g, ' ')
  if (normalized.length <= 240) {
    return normalized
  }
  return `${normalized.slice(0, 240)}...`
}

export class FixerOutputParseError extends Error {
  constructor(
    message: string,
    readonly excerpt: string,
  ) {
    super(message)
    this.name = 'FixerOutputParseError'
  }
}

export const parseFixerOutput = (output: string): FixerOutput => {
  let parsed: unknown
  try {
    parsed = extractJson(output)
  } catch (error) {
    throw new FixerOutputParseError(
      `Fixer output is missing a final JSON object: ${error instanceof Error ? error.message : 'unknown parse error'}`,
      outputExcerpt(output),
    )
  }

  const result = fixerOutputSchema.safeParse(parsed)
  if (!result.success) {
    throw new FixerOutputParseError(
      `Fixer output does not match schema: ${summarizeZodIssues(result.error)}`,
      outputExcerpt(output),
    )
  }

  return result.data
}
