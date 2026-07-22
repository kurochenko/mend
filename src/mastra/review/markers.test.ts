import { describe, expect, it } from 'bun:test'
import {
  appendInlineMarkers,
  appendSummaryFindingMarkers,
  appendSummaryMarkers,
  isCurrentRunDraft,
  isMendDraft,
  parseMendMarkers,
} from '@/mastra/review/markers'
import { hashBody } from '@/lib/hash'

describe('hashBody', () => {
  it('returns an 8-character hex string', () => {
    const hash = hashBody('some comment body')
    expect(hash).toMatch(/^[a-f0-9]{8}$/)
  })

  it('returns the same hash for the same input', () => {
    expect(hashBody('hello')).toBe(hashBody('hello'))
  })

  it('returns different hashes for different inputs', () => {
    expect(hashBody('hello')).not.toBe(hashBody('world'))
  })
})

describe('appendInlineMarkers', () => {
  it('appends inline and run markers', () => {
    const result = appendInlineMarkers('body text', 'run-42', 'src/foo.ts', 10)
    const hash = hashBody('body text')

    expect(result).toContain('body text')
    expect(result).toContain(`<!-- mend:inline:src/foo.ts:10:${hash} -->`)
    expect(result).toContain('<!-- mend:draft-run:run-42 -->')
  })
})

describe('appendSummaryMarkers', () => {
  it('appends summary and run markers', () => {
    const result = appendSummaryMarkers('summary text', 'run-99')

    expect(result).toContain('summary text')
    expect(result).toContain('<!-- mend:summary -->')
    expect(result).toContain('<!-- mend:draft-run:run-99 -->')
  })
})

describe('appendSummaryFindingMarkers', () => {
  it('appends summary finding and run markers', () => {
    const result = appendSummaryFindingMarkers('finding text', 'run-77', {
      fingerprint: 'summary_finding:dup-layout',
      previousFindingId: 'dup-layout',
      path: 'src/app.ts',
      line: 42,
    })

    expect(result).toContain('finding text')
    expect(result).toContain('<!-- mend:summary-finding ')
    expect(result).toContain('<!-- mend:draft-run:run-77 -->')
  })
})

describe('isCurrentRunDraft', () => {
  it('returns true when body contains the run marker', () => {
    const body = 'content\n\n<!-- mend:draft-run:run-42 -->'
    expect(isCurrentRunDraft(body, 'run-42')).toBe(true)
  })

  it('returns false for a different run id', () => {
    const body = 'content\n\n<!-- mend:draft-run:run-42 -->'
    expect(isCurrentRunDraft(body, 'run-99')).toBe(false)
  })
})

describe('isMendDraft', () => {
  it('returns true for any mend draft', () => {
    const body = 'content\n\n<!-- mend:draft-run:run-42 -->'
    expect(isMendDraft(body)).toBe(true)
  })

  it('returns false for non-mend content', () => {
    expect(isMendDraft('just regular text')).toBe(false)
  })
})

describe('parseMendMarkers', () => {
  it('parses inline markers', () => {
    const body = appendInlineMarkers('comment body', 'run-1', 'src/app.ts', 42)
    const parsed = parseMendMarkers(body)

    expect(parsed.runId).toBe('run-1')
    expect(parsed.inline).toEqual({
      file: 'src/app.ts',
      line: 42,
      bodyHash: hashBody('comment body'),
    })
    expect(parsed.isSummary).toBe(false)
  })

  it('parses summary markers', () => {
    const body = appendSummaryMarkers('summary content', 'run-2')
    const parsed = parseMendMarkers(body)

    expect(parsed.runId).toBe('run-2')
    expect(parsed.inline).toBeUndefined()
    expect(parsed.summaryFinding).toBeUndefined()
    expect(parsed.isSummary).toBe(true)
  })

  it('parses summary finding markers', () => {
    const body = appendSummaryFindingMarkers('finding body', 'run-4', {
      fingerprint: 'summary_finding:dup-layout',
      previousFindingId: 'dup-layout',
      path: 'src/app.ts',
      line: 42,
    })
    const parsed = parseMendMarkers(body)

    expect(parsed.runId).toBe('run-4')
    expect(parsed.inline).toBeUndefined()
    expect(parsed.summaryFinding).toEqual({
      fingerprint: 'summary_finding:dup-layout',
      previousFindingId: 'dup-layout',
      path: 'src/app.ts',
      line: 42,
    })
    expect(parsed.isSummary).toBe(false)
  })

  it('returns empty result for unmarked body', () => {
    const parsed = parseMendMarkers('plain text')

    expect(parsed.runId).toBeUndefined()
    expect(parsed.inline).toBeUndefined()
    expect(parsed.summaryFinding).toBeUndefined()
    expect(parsed.isSummary).toBe(false)
  })

  it('handles files with colons in the path', () => {
    const body = appendInlineMarkers('body', 'run-3', 'src/utils:helper.ts', 5)
    const parsed = parseMendMarkers(body)

    expect(parsed.inline?.file).toBe('src/utils:helper.ts')
    expect(parsed.inline?.line).toBe(5)
  })
})
