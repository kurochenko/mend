import {
  reviewTemplateIds,
  type ReviewIntent,
  type ReviewTemplateId,
} from '@/mastra/review/intents'

export { reviewTemplateIds }
export type ReviewTemplateSource = 'config' | 'label' | 'classifier' | 'fallback'

export interface TemplateSelectionInput {
  classifiedIntent: ReviewIntent
  classifiedConfidence: number
  configTemplate: ReviewTemplateId | 'auto'
  labels: string[]
  labelPrefix: string
}

export interface TemplateSelectionResult {
  templateId: ReviewTemplateId
  source: ReviewTemplateSource
  warnings: string[]
}

const CLASSIFIER_TEMPLATE_CONFIDENCE_THRESHOLD = 0.85

const reviewTemplateSet = new Set<string>(reviewTemplateIds)

const isReviewTemplateId = (value: string): value is ReviewTemplateId =>
  reviewTemplateSet.has(value)

const normalizeLabelPrefix = (value: string): string => {
  const trimmed = value.trim()
  if (!trimmed) {
    return 'ai-review:'
  }
  return trimmed.endsWith(':') ? trimmed : `${trimmed}:`
}

const selectFromLabel = (
  labels: string[],
  labelPrefix: string,
): { templateId: ReviewTemplateId | null; warnings: string[] } => {
  const warnings: string[] = []
  const normalizedPrefix = normalizeLabelPrefix(labelPrefix)

  for (const label of labels) {
    if (!label.startsWith(normalizedPrefix)) {
      continue
    }
    const rawValue = label.slice(normalizedPrefix.length).trim().toLowerCase()
    if (isReviewTemplateId(rawValue)) {
      return { templateId: rawValue, warnings }
    }
    warnings.push(`ignored invalid template label override: ${label}`)
  }

  return { templateId: null, warnings }
}

export const selectReviewTemplate = (input: TemplateSelectionInput): TemplateSelectionResult => {
  const warnings: string[] = []

  if (input.configTemplate !== 'auto') {
    return {
      templateId: input.configTemplate,
      source: 'config',
      warnings,
    }
  }

  const fromLabel = selectFromLabel(input.labels, input.labelPrefix)
  warnings.push(...fromLabel.warnings)
  if (fromLabel.templateId) {
    return {
      templateId: fromLabel.templateId,
      source: 'label',
      warnings,
    }
  }

  if (
    input.classifiedIntent !== 'mixed' &&
    input.classifiedConfidence >= CLASSIFIER_TEMPLATE_CONFIDENCE_THRESHOLD
  ) {
    return {
      templateId: input.classifiedIntent,
      source: 'classifier',
      warnings,
    }
  }

  if (input.classifiedIntent !== 'mixed') {
    warnings.push(
      `classifier confidence ${input.classifiedConfidence.toFixed(2)} below threshold ${CLASSIFIER_TEMPLATE_CONFIDENCE_THRESHOLD.toFixed(2)}; using mixed template`,
    )
  }

  return {
    templateId: 'mixed',
    source: 'fallback',
    warnings,
  }
}
