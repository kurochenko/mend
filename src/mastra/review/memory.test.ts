import { describe, expect, test } from 'bun:test'
import type { ReviewMemoryEntryRecord } from '@/db/review-memory'
import { buildReviewMemoryPromptSections } from '@/mastra/review/memory'

const makeMemory = (overrides: Partial<ReviewMemoryEntryRecord>): ReviewMemoryEntryRecord => ({
  id: 'memory-1',
  scope: 'mr',
  status: 'active',
  projectKey: 'cookt',
  mrIid: 81,
  threadId: 'thread-1',
  sourceMessageId: 'message-1',
  kind: 'ignore_this_mr',
  instruction: 'Do not re-raise this concern again on this merge request.',
  matchFingerprint: 'src/app.ts:42:deadbeef',
  matchPath: 'src/app.ts',
  matchLine: 42,
  matchCategory: null,
  metadata: { sourceBody: 'Guard is missing.' },
  createdByExternalId: '1',
  createdByName: 'reviewer',
  createdAt: new Date('2026-03-07T20:00:00.000Z'),
  updatedAt: new Date('2026-03-07T20:00:00.000Z'),
  ...overrides,
})

describe('buildReviewMemoryPromptSections', () => {
  test('renders MR and project memory sections', () => {
    const sections = buildReviewMemoryPromptSections([
      makeMemory({ scope: 'mr', instruction: 'Ignore this on the current MR.' }),
      makeMemory({
        id: 'memory-2',
        scope: 'project',
        mrIid: null,
        instruction: 'Do not require UI/component tests for this project.',
      }),
    ])

    expect(sections).toHaveLength(2)
    expect(sections[0]).toContain('## Active MR Decisions')
    expect(sections[1]).toContain('## Project Review Memory')
    expect(sections[0]).toContain(
      'If a candidate finding matches an entry below (same file and line, or clearly the same underlying concern), omit it entirely.',
    )
    expect(sections[0]).toContain(
      '- [src/app.ts:42] Ignore this on the current MR. — original finding: "Guard is missing."',
    )
    expect(sections[1]).toContain(
      '- [src/app.ts:42] Do not require UI/component tests for this project. — original finding: "Guard is missing."',
    )
  })

  test('omits location and excerpt when memory lacks path, line, and source body', () => {
    const sections = buildReviewMemoryPromptSections([
      makeMemory({
        matchPath: null,
        matchLine: null,
        metadata: {},
      }),
    ])

    expect(sections[0]).toContain('- Do not re-raise this concern again on this merge request.')
    expect(sections[0]).not.toContain('[src/app.ts:42]')
    expect(sections[0]).not.toContain('original finding')
  })

  test('truncates long original finding excerpts', () => {
    const sections = buildReviewMemoryPromptSections([
      makeMemory({
        metadata: { sourceBody: 'x'.repeat(220) },
      }),
    ])

    expect(sections[0]).toContain(`${'x'.repeat(197)}...`)
    expect(sections[0]).not.toContain('x'.repeat(220))
  })
})
