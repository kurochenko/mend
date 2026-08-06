import { describe, expect, it } from 'bun:test'
import {
  applyBlockingReviewPolicy,
  collectExpectedPriorBlockerIds,
} from '@/mastra/review/blocking-policy'
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

const expectedPriorBlocker = 'finding:discussion-previous'

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
            previousFindingId: expectedPriorBlocker,
            status,
            explanation: 'The previous blocker is still unresolved.',
          },
        ],
      }),
      [expectedPriorBlocker],
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
            previousFindingId: expectedPriorBlocker,
            status: 'fixed',
            explanation: 'The previous blocker is fixed.',
          },
        ],
      }),
      [expectedPriorBlocker],
    )

    expect(result.assessment).toBe('approve')
    expect(result.summary).toBe('No release- or development-blocking defects found.')
    expect(result.resolutionVerdicts).toEqual([
      {
        previousFindingId: expectedPriorBlocker,
        status: 'fixed',
        explanation: 'The previous blocker is fixed.',
      },
    ])
  })

  it('ignores verdicts that do not match an expected prior blocker', () => {
    const result = applyBlockingReviewPolicy(
      output({
        assessment: 'request_changes',
        resolutionVerdicts: [
          {
            previousFindingId: 'invented-blocker',
            status: 'not_fixed',
            explanation: 'This identifier is not present in previous context.',
          },
        ],
      }),
    )

    expect(result.assessment).toBe('approve')
    expect(result.summary).toBe('No release- or development-blocking defects found.')
    expect(result.resolutionVerdicts).toEqual([])
  })

  it('keeps approval blocked when an expected prior blocker verdict is omitted', () => {
    const result = applyBlockingReviewPolicy(output({ assessment: 'approve' }), [
      expectedPriorBlocker,
    ])

    expect(result.assessment).toBe('request_changes')
    expect(result.summary).toBe(
      '1 previous release- or development-blocking defect remains unresolved.',
    )
  })

  it('does not let an unmatched verdict override a fixed expected blocker', () => {
    const result = applyBlockingReviewPolicy(
      output({
        resolutionVerdicts: [
          {
            previousFindingId: expectedPriorBlocker,
            status: 'fixed',
            explanation: 'The tracked blocker is fixed.',
          },
          {
            previousFindingId: 'invented-blocker',
            status: 'not_fixed',
            explanation: 'This identifier is not present in previous context.',
          },
        ],
      }),
      [expectedPriorBlocker],
    )

    expect(result.assessment).toBe('approve')
    expect(result.resolutionVerdicts).toHaveLength(1)
  })

  it('normalizes conflicting duplicate verdicts conservatively before posting', () => {
    const result = applyBlockingReviewPolicy(
      output({
        resolutionVerdicts: [
          {
            previousFindingId: expectedPriorBlocker,
            status: 'fixed',
            explanation: 'One pass considered it fixed.',
          },
          {
            previousFindingId: expectedPriorBlocker,
            status: 'not_fixed',
            explanation: 'Another pass found the blocker remains.',
          },
        ],
      }),
      [expectedPriorBlocker],
    )

    expect(result.assessment).toBe('request_changes')
    expect(result.resolutionVerdicts).toEqual([
      {
        previousFindingId: expectedPriorBlocker,
        status: 'not_fixed',
        explanation: 'Another pass found the blocker remains.',
      },
    ])
  })

  it('retains needs discussion when there are no blocking findings', () => {
    const result = applyBlockingReviewPolicy(output({ assessment: 'needs_discussion' }))

    expect(result.assessment).toBe('needs_discussion')
    expect(result.summary).toBe(
      'Review requires discussion; no release- or development-blocking defects were retained.',
    )
  })
})

describe('collectExpectedPriorBlockerIds', () => {
  it('returns only open tracked material findings and inline comments', () => {
    const result = collectExpectedPriorBlockerIds({
      findings: [
        {
          identity: 'finding:discussion-1',
          id: 'open-finding',
          category: 'correctness',
          severity: 'bug',
          actionability: 'required',
          title: 'Open finding',
          body: 'body',
          files: ['src/app.ts'],
          discussionId: 'discussion-1',
          resolved: false,
        },
        {
          identity: 'finding:discussion-2',
          id: 'resolved-finding',
          category: 'correctness',
          severity: 'bug',
          actionability: 'required',
          title: 'Resolved finding',
          body: 'body',
          files: ['src/app.ts'],
          discussionId: 'discussion-2',
          resolved: true,
        },
        {
          identity: null,
          id: 'untracked-finding',
          category: 'correctness',
          severity: 'bug',
          actionability: 'required',
          title: 'Untracked finding',
          body: 'body',
          files: ['src/app.ts'],
          discussionId: null,
          resolved: false,
        },
        {
          identity: 'finding:discussion-optional',
          id: 'optional-finding',
          category: 'performance',
          severity: 'performance',
          actionability: 'optional',
          title: 'Optional finding',
          body: 'body',
          files: ['src/app.ts'],
          discussionId: 'discussion-optional',
          resolved: false,
        },
        {
          identity: 'finding:discussion-recommended',
          id: 'recommended-finding',
          category: 'security',
          severity: 'security',
          actionability: 'recommended',
          title: 'Recommended finding',
          body: 'body',
          files: ['src/app.ts'],
          discussionId: 'discussion-recommended',
          resolved: false,
        },
      ],
      inlineComments: [
        {
          identity: 'inline:discussion-3',
          file: 'src/app.ts',
          line: 7,
          severity: 'security',
          actionability: 'required',
          body: 'Open inline blocker',
          discussionId: 'discussion-3',
          resolved: false,
        },
        {
          identity: 'inline:discussion-4',
          file: 'src/app.ts',
          line: 8,
          severity: 'suggestion',
          actionability: 'required',
          body: 'Open inline suggestion',
          discussionId: 'discussion-4',
          resolved: false,
        },
        {
          identity: 'inline:discussion-5',
          file: 'src/app.ts',
          line: 7,
          severity: 'bug',
          actionability: 'required',
          body: 'A distinct blocker on the same line',
          discussionId: 'discussion-5',
          resolved: false,
        },
      ],
    })

    expect(result).toEqual(['finding:discussion-1', 'inline:discussion-3', 'inline:discussion-5'])
  })
})
