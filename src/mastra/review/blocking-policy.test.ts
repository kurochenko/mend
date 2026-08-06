import { describe, expect, it } from 'bun:test'
import { applyBlockingReviewPolicy } from '@/mastra/review/blocking-policy'
import type { ReviewOutputV2 } from '@/mastra/review/schema'

const finding = (
  id: string,
  severity: ReviewOutputV2['findings'][number]['severity'],
  actionability: ReviewOutputV2['findings'][number]['actionability'],
): ReviewOutputV2['findings'][number] => ({
  id,
  category: 'correctness',
  severity,
  actionability,
  scope: 'single_file',
  title: id,
  body: `${id} body`,
  files: ['src/app.ts'],
  evidence: [{ type: 'file_line', file: 'src/app.ts', line: 1 }],
})

const output = (overrides: Partial<ReviewOutputV2> = {}): ReviewOutputV2 => ({
  version: 'v2',
  assessment: 'approve',
  summary: 'summary',
  findings: [],
  inlineComments: [],
  resolutionVerdicts: [],
  ...overrides,
})

describe('applyBlockingReviewPolicy', () => {
  it('retains required material severities and makes all of them block approval', () => {
    const result = applyBlockingReviewPolicy(
      output({
        findings: [
          finding('bug', 'bug', 'required'),
          finding('security', 'security', 'required'),
          finding('performance', 'performance', 'required'),
        ],
      }),
    )

    expect(result.findings.map((item) => item.id)).toEqual(['bug', 'security', 'performance'])
    expect(result.assessment).toBe('request_changes')
  })

  it('removes recommended, optional, and suggestion findings before posting', () => {
    const result = applyBlockingReviewPolicy(
      output({
        assessment: 'request_changes',
        findings: [
          finding('recommended', 'bug', 'recommended'),
          finding('optional', 'performance', 'optional'),
          finding('suggestion', 'suggestion', 'required'),
        ],
        inlineComments: [
          { file: 'src/app.ts', line: 1, severity: 'suggestion', body: 'optional cleanup' },
        ],
      }),
    )

    expect(result.findings).toEqual([])
    expect(result.inlineComments).toEqual([])
    expect(result.assessment).toBe('approve')
  })

  it('retains needs discussion when there are no blocking findings', () => {
    const result = applyBlockingReviewPolicy(output({ assessment: 'needs_discussion' }))

    expect(result.assessment).toBe('needs_discussion')
  })
})
