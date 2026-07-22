import { describe, expect, it } from 'bun:test'
import {
  parseReviewOutputV2,
  ReviewOutputParseError,
  reviewOutputV2Schema,
} from '@/mastra/review/schema'

const validPayload = {
  version: 'v2',
  assessment: 'needs_discussion',
  summary: 'Review summary',
  meta: {
    templateId: 'style_refactor',
    intent: 'style_refactor',
    confidence: 0.92,
    selectionSource: 'classifier',
  },
  findings: [
    {
      id: 'dup-layout',
      category: 'duplication',
      severity: 'suggestion',
      actionability: 'recommended',
      scope: 'cross_file',
      title: 'Duplicated layout',
      body: 'Two views duplicate the same structure',
      files: ['src/a.vue', 'src/b.vue'],
      evidence: [
        {
          type: 'file_line',
          file: 'src/a.vue',
          line: 1,
          note: 'same structure as b.vue',
        },
      ],
    },
  ],
  inlineComments: [
    {
      file: 'src/components/Table.vue',
      line: 80,
      severity: 'suggestion',
      body: 'Prefer Tailwind built-in utility',
    },
  ],
}

describe('reviewOutputV2Schema', () => {
  it('validates a complete v2 payload', () => {
    const parsed = reviewOutputV2Schema.parse(validPayload)
    expect(parsed.version).toBe('v2')
    expect(parsed.findings.length).toBe(1)
    expect(parsed.inlineComments.length).toBe(1)
  })

  it('rejects payloads without version v2', () => {
    const result = reviewOutputV2Schema.safeParse({
      ...validPayload,
      version: 'v1',
    })

    expect(result.success).toBe(false)
  })

  it('validates when model output omits meta', () => {
    const withoutMeta: Partial<typeof validPayload> = { ...validPayload }
    delete withoutMeta.meta
    const parsed = reviewOutputV2Schema.parse(withoutMeta)

    expect(parsed.meta).toBeUndefined()
  })

  it('rejects findings without evidence', () => {
    const result = reviewOutputV2Schema.safeParse({
      ...validPayload,
      findings: [{ ...validPayload.findings[0], evidence: [] }],
    })

    expect(result.success).toBe(false)
  })
})

describe('parseReviewOutputV2', () => {
  it('parses JSON object embedded in fenced block', () => {
    const raw = `\n\`\`\`json\n${JSON.stringify(validPayload, null, 2)}\n\`\`\``
    const parsed = parseReviewOutputV2(raw)
    expect(parsed.meta?.templateId).toBe('style_refactor')
  })

  it('throws a clear error when final JSON is missing', () => {
    expect(() => parseReviewOutputV2('I am still exploring the diff')).toThrow(
      'Review output is missing a final JSON object',
    )
  })

  it('throws a clear error when JSON shape is invalid', () => {
    try {
      parseReviewOutputV2(JSON.stringify({ version: 'v2', assessment: 'approve' }))
      throw new Error('expected parse to fail')
    } catch (error) {
      expect(error).toBeInstanceOf(ReviewOutputParseError)
      expect((error as ReviewOutputParseError).message).toContain(
        'Review output JSON does not match schema',
      )
      expect((error as ReviewOutputParseError).message).toContain('summary')
    }
  })
})
