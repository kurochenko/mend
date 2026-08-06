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
        summary: 'Consider these optional improvements and rename this variable.',
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
    expect(result.summary).toBe('No release- or development-blocking defects found.')
    expect(result.summary).not.toContain('optional improvements')
  })

  it('regenerates a filtered summary from retained blocking defects', () => {
    const result = applyBlockingReviewPolicy(
      output({
        summary: 'Fix the crash and consider renaming the helper.',
        findings: [
          finding('crash', 'bug', 'required'),
          finding('rename', 'suggestion', 'optional'),
        ],
      }),
    )

    expect(result.assessment).toBe('request_changes')
    expect(result.summary).toBe('Review found 1 release- or development-blocking defect.')
    expect(result.summary).not.toContain('renaming')
  })

  it('regenerates a summary when optional advice appears only in free text', () => {
    const result = applyBlockingReviewPolicy(
      output({ summary: 'The change works, but consider extracting this helper.' }),
    )

    expect(result.assessment).toBe('approve')
    expect(result.summary).toBe('No release- or development-blocking defects found.')
    expect(result.summary).not.toContain('extracting this helper')
  })

  it.each([
    'not_fixed',
    'partially_fixed',
    'cannot_determine',
  ] as const)('keeps an update blocked when a previous finding is %s', (status) => {
    const result = applyBlockingReviewPolicy(
      output({
        assessment: 'approve',
        summary: 'All previous findings are fixed.',
        resolutionVerdicts: [
          {
            previousFindingId: 'previous-blocker',
            status,
            explanation: 'The previous blocker is still unresolved.',
          },
        ],
      }),
    )

    expect(result.assessment).toBe('request_changes')
    expect(result.summary).toBe(
      '1 previous release- or development-blocking defect remains unresolved.',
    )
    expect(result.summary).not.toContain('All previous findings are fixed')
  })

  it('allows approval when every previous blocker is fixed', () => {
    const result = applyBlockingReviewPolicy(
      output({
        assessment: 'request_changes',
        resolutionVerdicts: [
          {
            previousFindingId: 'previous-blocker',
            status: 'fixed',
            explanation: 'The previous blocker is fixed.',
          },
        ],
      }),
    )

    expect(result.assessment).toBe('approve')
    expect(result.summary).toBe('No release- or development-blocking defects found.')
  })

  it('retains needs discussion when there are no blocking findings', () => {
    const result = applyBlockingReviewPolicy(output({ assessment: 'needs_discussion' }))

    expect(result.assessment).toBe('needs_discussion')
    expect(result.summary).toBe(
      'Review requires discussion; no release- or development-blocking defects were retained.',
    )
  })
})
