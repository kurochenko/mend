import { describe, expect, it } from 'bun:test'
import { appendSummaryMarkers } from '@/mastra/review/markers'
import { automaticLoopLimitBody } from '@/mastra/fix/automatic-batch'
import { buildResolvedFindingStateUpdate } from '@/server/thread-sync'
import {
  dedupeInlineComments,
  findingHasInlineAnchor,
  shouldPostFindingAsDiscussion,
} from '@/mastra/review/publish-plan'
import { findMrNoteByBody, findPublishedSummaryForRun } from '@/mastra/review/publish-executor'

describe('dedupeInlineComments', () => {
  it('removes identical inline comments while preserving order', () => {
    const first = {
      file: 'src/app.ts',
      line: 10,
      severity: 'bug' as const,
      body: 'First issue',
    }
    const duplicate = {
      file: 'src/app.ts',
      line: 10,
      severity: 'bug' as const,
      body: 'First issue',
    }
    const withSuggestion = {
      file: 'src/app.ts',
      line: 10,
      severity: 'bug' as const,
      body: 'First issue',
      suggestion: 'const x = 1',
    }

    const comments = [first, duplicate, withSuggestion]

    expect(dedupeInlineComments(comments)).toEqual([first, withSuggestion])
  })
})

describe('findPublishedSummaryForRun', () => {
  it('finds the current-run summary note by marker', () => {
    const summaryBody = appendSummaryMarkers('Summary', 'run-42')
    const notes = [
      { id: 1, body: 'plain note', author: null },
      { id: 2, body: summaryBody, author: null },
    ]

    expect(findPublishedSummaryForRun(notes, 'run-42')?.id).toBe(2)
  })
})

describe('findMrNoteByBody', () => {
  it('finds an existing note with the exact same body', () => {
    const notes = [
      { id: 1, body: 'plain note', author: null },
      { id: 2, body: 'loop limit body', author: null },
    ]

    expect(findMrNoteByBody(notes, 'loop limit body')?.id).toBe(2)
    expect(findMrNoteByBody(notes, 'missing')).toBeUndefined()
  })
})

describe('automaticLoopLimitBody', () => {
  it('summarizes the stopped automatic fix loop for a human reviewer', () => {
    expect(
      automaticLoopLimitBody('demo', 42, {
        status: 'loop_limit',
        batch: {} as never,
        maxLoops: 3,
      }),
    ).toContain('maximum of 3 fix loop(s)')
  })
})

describe('buildResolvedFindingStateUpdate', () => {
  it('maps a verified fixed reply into a resolved finding state update', () => {
    expect(
      buildResolvedFindingStateUpdate({
        id: 9,
        body: 'Verified as fixed in `abc123`: Guard was added',
        author: { id: 7, username: 'mend-bot', raw: { id: 7 } },
        resolvable: true,
        raw: { id: 9 },
      }),
    ).toEqual({
      state: 'resolved',
      decisionReason: 'Verified as fixed in `abc123`: Guard was added',
      decidedByExternalId: '7',
      decidedByName: 'mend-bot',
    })
  })
})

describe('finding discussion strategy', () => {
  it('treats single-file findings with matching inline anchors as inline-backed', () => {
    const finding = {
      id: 'placeholder-sync',
      category: 'correctness' as const,
      severity: 'bug' as const,
      actionability: 'recommended' as const,
      scope: 'single_file' as const,
      title: 'Placeholder falls out of sync',
      body: 'The placeholder is captured only once.',
      files: ['src/components/DatePicker.vue'],
      evidence: [
        {
          type: 'file_line' as const,
          file: 'src/components/DatePicker.vue',
          line: 46,
        },
      ],
    }
    const inlineAnchorKeys = new Set(['src/components/DatePicker.vue:46'])

    expect(findingHasInlineAnchor(finding, inlineAnchorKeys)).toBe(true)
    expect(shouldPostFindingAsDiscussion(finding, inlineAnchorKeys)).toBe(false)
  })

  it('posts single-file findings without matching inline anchors as separate discussions', () => {
    const finding = {
      id: 'dead-prop',
      category: 'dead_code' as const,
      severity: 'suggestion' as const,
      actionability: 'recommended' as const,
      scope: 'single_file' as const,
      title: 'Dead prop remains in interface',
      body: 'The prop is declared but never used.',
      files: ['src/components/CollapsibleFormSection.vue'],
      evidence: [
        {
          type: 'file_line' as const,
          file: 'src/components/CollapsibleFormSection.vue',
          line: 16,
        },
      ],
    }

    expect(findingHasInlineAnchor(finding, new Set())).toBe(false)
    expect(shouldPostFindingAsDiscussion(finding, new Set())).toBe(true)
  })

  it('treats cross-file findings with matching inline anchors as inline-backed', () => {
    const finding = {
      id: 'quote-sort-fields',
      category: 'duplication' as const,
      severity: 'suggestion' as const,
      actionability: 'recommended' as const,
      scope: 'cross_file' as const,
      title: 'QuoteSortField value arrays are duplicated across two files',
      body: 'The same issue is already represented by an inline suggestion.',
      files: [
        'src/components/features/btlFirst/composables/useProductsTable.ts',
        'src/http/loanCaseV3.ts',
      ],
      evidence: [
        {
          type: 'file_line' as const,
          file: 'src/http/loanCaseV3.ts',
          line: 256,
        },
      ],
    }
    const inlineAnchorKeys = new Set(['src/http/loanCaseV3.ts:256'])

    expect(findingHasInlineAnchor(finding, inlineAnchorKeys)).toBe(true)
    expect(shouldPostFindingAsDiscussion(finding, inlineAnchorKeys)).toBe(false)
  })
})
