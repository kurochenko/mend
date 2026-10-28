import { describe, expect, it, mock } from 'bun:test'
import {
  buildPersistablePostedReviewFindings,
  mapPublishedInlineThreadRefs,
  resolveReviewedDiffContext,
} from '@/mastra/review/publish-executor'
import type { PlannedInlineDraft } from '@/mastra/review/publish-plan'

const draft = (source: PlannedInlineDraft['source'], fingerprint: string): PlannedInlineDraft => ({
  source,
  path: 'src/app.ts',
  line: 2,
  fingerprint,
  body: 'body',
  markedBody: 'marked body',
  anchor: { new_line: 2 },
})

describe('mapPublishedInlineThreadRefs', () => {
  it('maps native inline and structured finding threads back to their source indexes', () => {
    const result = mapPublishedInlineThreadRefs({
      inlineDrafts: [
        draft({ kind: 'inline_comment', index: 1 }, 'inline-fingerprint'),
        draft({ kind: 'finding', index: 0 }, 'summary_finding:finding-1'),
      ],
      inlineCommentCount: 3,
      findingCount: 2,
      persistedInlineComments: [
        {
          findingFingerprint: 'inline-fingerprint',
          providerThreadId: 'inline-thread',
          providerMessageId: 'inline-message',
        },
      ],
      persistedFindings: [
        {
          findingFingerprint: 'summary_finding:finding-1',
          providerThreadId: 'finding-thread',
          providerMessageId: 'finding-message',
        },
      ],
    })

    expect(result.postedInlineComments).toEqual([
      { providerThreadId: null, providerMessageId: null },
      { providerThreadId: 'inline-thread', providerMessageId: 'inline-message' },
      { providerThreadId: null, providerMessageId: null },
    ])
    expect(result.postedFindings).toEqual([
      { providerThreadId: 'finding-thread', providerMessageId: 'finding-message' },
      { providerThreadId: null, providerMessageId: null },
    ])
  })
})

describe('buildPersistablePostedReviewFindings', () => {
  it('persists separately posted finding discussions for later update history', () => {
    const finding = {
      id: 'out-of-scope-blocker',
      category: 'correctness' as const,
      severity: 'bug' as const,
      actionability: 'required' as const,
      scope: 'cross_file' as const,
      title: 'Historical blocker',
      body: 'This tracked blocker must survive later updates.',
      files: ['src/old.ts'],
      evidence: [{ type: 'file_line' as const, file: 'src/old.ts', line: 4 }],
      providerThreadId: 'finding-thread',
      providerMessageId: 'finding-message',
    }
    const inlineComment = {
      file: 'src/old.ts',
      line: 4,
      severity: 'bug' as const,
      body: 'A separate tracked inline blocker.',
      providerThreadId: 'inline-thread',
      providerMessageId: 'inline-message',
    }

    const result = buildPersistablePostedReviewFindings({
      findings: [],
      inlineComments: [],
      postedFindings: [],
      postedInlineComments: [],
      threadedFindings: [finding],
      threadedInlineComments: [inlineComment],
    })

    expect(result).toEqual([
      {
        ref: { providerThreadId: 'finding-thread', providerMessageId: 'finding-message' },
        metadata: { kind: 'finding', finding },
      },
      {
        ref: { providerThreadId: 'inline-thread', providerMessageId: 'inline-message' },
        metadata: { kind: 'inline_comment', inlineComment },
      },
    ])
  })
})

const reviewedDiff = [
  'diff --git a/src/app.ts b/src/app.ts',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,1 +1,2 @@',
  ' const a = 1',
  '+const b = 2',
  '',
].join('\n')

describe('resolveReviewedDiffContext', () => {
  it('anchors positions on the reviewed commit diff refs instead of the current MR head', async () => {
    const reviewedRefs = { baseSha: 'reviewed-base', headSha: 'reviewed', startSha: 'start' }
    const fetchDiffRefs = mock(async () => ({ baseSha: 'base', headSha: 'newer-head' }))
    const fetchDiffRefsForCommit = mock(async () => reviewedRefs)
    const readDiff = mock(async () => reviewedDiff)

    const result = await resolveReviewedDiffContext({
      provider: { fetchDiffRefs, fetchDiffRefsForCommit },
      mrIid: 5,
      commitSha: 'reviewed',
      readDiff,
    })

    expect(result.diffRefs).toEqual(reviewedRefs)
    expect(result.diffMap.get('src/app.ts')?.get(2)).toBeDefined()
    expect(fetchDiffRefsForCommit).toHaveBeenCalledWith(5, 'reviewed')
    expect(readDiff).toHaveBeenCalledWith('reviewed-base')
    expect(fetchDiffRefs).not.toHaveBeenCalled()
  })

  it('leaves inline comments unanchored when the reviewed commit has no diff refs', async () => {
    const currentRefs = { baseSha: 'base', headSha: 'newer-head', startSha: 'start' }
    const readDiff = mock(async () => reviewedDiff)

    const result = await resolveReviewedDiffContext({
      provider: {
        fetchDiffRefs: mock(async () => currentRefs),
        fetchDiffRefsForCommit: mock(async () => null),
      },
      mrIid: 5,
      commitSha: 'reviewed',
      readDiff,
    })

    expect(result.diffRefs).toEqual(currentRefs)
    expect(result.diffMap.size).toBe(0)
    expect(readDiff).not.toHaveBeenCalled()
  })
})
