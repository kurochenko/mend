import { describe, expect, test } from 'bun:test'
import type { ImprovementProposalRecord } from '@/db/improvement-proposals'
import { parseStatusFlag, resolveProposalByPrefix } from '@/cli/improvements'

const makeProposal = (id: string): ImprovementProposalRecord => ({
  id,
  projectKey: 'demo',
  clusterSlug: 'slug',
  title: 'title',
  proposalType: 'tooling',
  body: 'body',
  evidence: [],
  occurrenceCount: 1,
  status: 'proposed',
  lastDigestAt: null,
  createdAt: new Date('2026-07-07T00:00:00Z'),
  updatedAt: new Date('2026-07-07T00:00:00Z'),
})

describe('resolveProposalByPrefix', () => {
  test('returns none when no matches', () => {
    expect(resolveProposalByPrefix([])).toEqual({ kind: 'none' })
  })

  test('returns match for a single record', () => {
    const record = makeProposal('abc123')
    expect(resolveProposalByPrefix([record])).toEqual({ kind: 'match', record })
  })

  test('returns ambiguous for multiple records', () => {
    const matches = [makeProposal('abc1'), makeProposal('abc2')]
    expect(resolveProposalByPrefix(matches)).toEqual({ kind: 'ambiguous', matches })
  })
})

describe('parseStatusFlag', () => {
  test('returns undefined when flag absent', () => {
    expect(parseStatusFlag(['list'])).toBeUndefined()
  })

  test('parses a valid status', () => {
    expect(parseStatusFlag(['--status', 'proposed'])).toBe('proposed')
  })

  test('throws on unknown status', () => {
    expect(() => parseStatusFlag(['--status', 'bogus'])).toThrow()
  })

  test('throws when flag value missing', () => {
    expect(() => parseStatusFlag(['--status'])).toThrow()
  })
})
