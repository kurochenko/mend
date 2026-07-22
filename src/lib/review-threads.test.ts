import { describe, expect, it } from 'bun:test'
import {
  buildInlineThreadFingerprint,
  buildInlineThreadFingerprintFromHash,
  buildSummaryFindingThreadFingerprint,
  normalizeReviewMessageBody,
} from '@/lib/review-threads'
import { hashBody } from '@/lib/hash'

describe('normalizeReviewMessageBody', () => {
  it('trims and collapses whitespace', () => {
    expect(normalizeReviewMessageBody('  hello\n\nworld  ')).toBe('hello world')
  })
})

describe('buildInlineThreadFingerprint', () => {
  it('matches the hash-based variant', () => {
    const body = 'Body text'
    expect(buildInlineThreadFingerprint('src/app.ts', 42, body)).toBe(
      buildInlineThreadFingerprintFromHash('src/app.ts', 42, hashBody(body)),
    )
  })
})

describe('buildSummaryFindingThreadFingerprint', () => {
  it('prefixes stable summary finding identifiers', () => {
    expect(buildSummaryFindingThreadFingerprint('dup-layout')).toBe('summary_finding:dup-layout')
  })
})
