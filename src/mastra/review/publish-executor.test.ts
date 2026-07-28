import { describe, expect, it } from 'bun:test'
import { mapPublishedInlineThreadRefs } from '@/mastra/review/publish-executor'
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
