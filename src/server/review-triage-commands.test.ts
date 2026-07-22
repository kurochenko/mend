import { describe, expect, test } from 'bun:test'
import { DEFAULT_REJECT_REASON, parseReviewTriageCommand } from '@/server/review-triage-commands'

describe('parseReviewTriageCommand', () => {
  test('parses accept with the canonical mend mention', () => {
    expect(parseReviewTriageCommand('@mend accept', 'mend-bot')).toEqual({ kind: 'accept' })
  })

  test('parses configured bot username aliases', () => {
    expect(parseReviewTriageCommand('@mend-bot accept', 'mend-bot')).toEqual({ kind: 'accept' })
  })

  test('parses reject with an optional reason and default fallback', () => {
    expect(parseReviewTriageCommand('@mend reject flaky environment', 'mend-bot')).toEqual({
      kind: 'reject',
      reason: 'flaky environment',
    })
    expect(parseReviewTriageCommand('@mend reject', 'mend-bot')).toEqual({
      kind: 'reject',
      reason: DEFAULT_REJECT_REASON,
    })
  })

  test('requires a defer reason', () => {
    expect(
      parseReviewTriageCommand('@mend defer waiting for product decision', 'mend-bot'),
    ).toEqual({
      kind: 'defer',
      reason: 'waiting for product decision',
    })
    expect(parseReviewTriageCommand('@mend defer', 'mend-bot')).toEqual({ kind: 'invalid_defer' })
  })

  test('parses fix accepted commands without starting work', () => {
    expect(parseReviewTriageCommand('@mend fix accepted', 'mend-bot')).toEqual({
      kind: 'fix_accepted',
      force: false,
    })
    expect(parseReviewTriageCommand('@mend fix accepted anyway', 'mend-bot')).toEqual({
      kind: 'fix_accepted',
      force: true,
    })
  })

  test('finds commands inside longer comments and ignores marker content', () => {
    const body =
      '<!-- mend:conversation {"type":"scope_clarification"} -->\nLooks fine. @mend accept'
    expect(parseReviewTriageCommand(body, 'mend-bot')).toEqual({ kind: 'accept' })
  })

  test('ignores near mentions and unrelated text', () => {
    expect(parseReviewTriageCommand('email me at user@mend accept', 'mend-bot')).toBeNull()
    expect(parseReviewTriageCommand('@mender accept', 'mend-bot')).toBeNull()
    expect(parseReviewTriageCommand('@mend acceptable?', 'mend-bot')).toBeNull()
    expect(parseReviewTriageCommand('@mend rejected', 'mend-bot')).toBeNull()
    expect(parseReviewTriageCommand('accept this please', 'mend-bot')).toBeNull()
  })
})
