import { describe, expect, it } from 'bun:test'
import { selectReviewTemplate } from '@/mastra/review/template-selection'

describe('selectReviewTemplate', () => {
  it('uses config override when provided', () => {
    const result = selectReviewTemplate({
      classifiedIntent: 'bugfix',
      classifiedConfidence: 0.87,
      configTemplate: 'security_sensitive',
      labels: ['ai-review:style_refactor'],
      labelPrefix: 'ai-review:',
    })

    expect(result.templateId).toBe('security_sensitive')
    expect(result.source).toBe('config')
  })

  it('uses label override when config is auto', () => {
    const result = selectReviewTemplate({
      classifiedIntent: 'feature',
      classifiedConfidence: 0.8,
      configTemplate: 'auto',
      labels: ['ai-review:bugfix'],
      labelPrefix: 'ai-review:',
    })

    expect(result.templateId).toBe('bugfix')
    expect(result.source).toBe('label')
  })

  it('ignores invalid label override and continues', () => {
    const result = selectReviewTemplate({
      classifiedIntent: 'feature',
      classifiedConfidence: 0.91,
      configTemplate: 'auto',
      labels: ['ai-review:unknown-template'],
      labelPrefix: 'ai-review:',
    })

    expect(result.templateId).toBe('feature')
    expect(result.source).toBe('classifier')
    expect(result.warnings.length).toBe(1)
  })

  it('uses classifier when confidence is sufficient', () => {
    const result = selectReviewTemplate({
      classifiedIntent: 'style_refactor',
      classifiedConfidence: 0.91,
      configTemplate: 'auto',
      labels: [],
      labelPrefix: 'ai-review:',
    })

    expect(result.templateId).toBe('style_refactor')
    expect(result.source).toBe('classifier')
  })

  it('falls back to mixed when confidence is low', () => {
    const result = selectReviewTemplate({
      classifiedIntent: 'feature',
      classifiedConfidence: 0.42,
      configTemplate: 'auto',
      labels: [],
      labelPrefix: 'ai-review:',
    })

    expect(result.templateId).toBe('mixed')
    expect(result.source).toBe('fallback')
    expect(result.warnings.length).toBe(1)
  })

  it('falls back to mixed when confidence is moderate', () => {
    const result = selectReviewTemplate({
      classifiedIntent: 'feature',
      classifiedConfidence: 0.74,
      configTemplate: 'auto',
      labels: [],
      labelPrefix: 'ai-review:',
    })

    expect(result.templateId).toBe('mixed')
    expect(result.source).toBe('fallback')
    expect(result.warnings[0]).toContain('below threshold')
  })

  it('falls back to mixed when classifier intent is mixed', () => {
    const result = selectReviewTemplate({
      classifiedIntent: 'mixed',
      classifiedConfidence: 0.5,
      configTemplate: 'auto',
      labels: [],
      labelPrefix: 'ai-review:',
    })

    expect(result.templateId).toBe('mixed')
    expect(result.source).toBe('fallback')
  })

  it('supports label prefix without trailing colon', () => {
    const result = selectReviewTemplate({
      classifiedIntent: 'feature',
      classifiedConfidence: 0.91,
      configTemplate: 'auto',
      labels: ['ai-review:security_sensitive'],
      labelPrefix: 'ai-review',
    })

    expect(result.templateId).toBe('security_sensitive')
    expect(result.source).toBe('label')
  })
})
