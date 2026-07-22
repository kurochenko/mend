import { describe, expect, it } from 'bun:test'
import { formatSummaryNote } from '@/mastra/review/formatting'

describe('formatSummaryNote', () => {
  it('includes the review number in the summary heading', () => {
    const note = formatSummaryNote(3, 'approve', 'Looks good.', [], 0, 0, [])

    expect(note).toContain('## Mend Review #3')
  })
})
