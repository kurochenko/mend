import { describe, expect, test } from 'bun:test'
import type { ReviewFindingRecord } from '@/db/review-findings'
import { buildFixerPrompt } from '@/mastra/fix/prompt'

const makeFinding = (id: string, state: ReviewFindingRecord['state']): ReviewFindingRecord => ({
  id,
  projectKey: 'demo',
  mrIid: 42,
  reviewRunId: 'run-1',
  threadId: `thread-${id}`,
  provider: 'gitlab',
  providerThreadId: `discussion-${id}`,
  providerNoteId: `note-${id}`,
  state,
  decisionReason: state === 'rejected' ? 'not valid' : null,
  decidedByExternalId: null,
  decidedByName: null,
  decidedAt: null,
  metadata: { title: `${id} title`, files: [`src/${id}.ts`] },
  createdAt: new Date('2026-06-04T00:00:00Z'),
  updatedAt: new Date('2026-06-04T00:00:00Z'),
})

describe('buildFixerPrompt', () => {
  test('renders work findings and context-only findings separately', () => {
    const prompt = buildFixerPrompt({
      projectKey: 'demo',
      mrIid: 42,
      acceptedFindings: [makeFinding('accepted-1', 'accepted')],
      contextFindings: [makeFinding('rejected-1', 'rejected'), makeFinding('pending-1', 'pending')],
      checks: ['bun test', 'bun run lint'],
    })

    expect(prompt).toContain('Findings to fix:')
    expect(prompt).toContain('id: accepted-1')
    expect(prompt).toContain('Context findings only. Do not fix these as work items:')
    expect(prompt).toContain('id: rejected-1')
    expect(prompt).toContain('decisionReason: not valid')
    expect(prompt).toContain('id: pending-1')
    expect(prompt).toContain('- bun test')
    expect(prompt).toContain('"version": "fixer-v1"')
  })
})
