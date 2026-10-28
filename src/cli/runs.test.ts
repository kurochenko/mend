import { describe, expect, test } from 'bun:test'
import type { ReviewRunRecord } from '@/db/review-runs'
import { formatRunsTable, parseRunsArgs } from '@/cli/runs'

const run = (overrides: Partial<ReviewRunRecord> = {}): ReviewRunRecord => ({
  id: 'run-1',
  projectKey: 'demo',
  mrIid: 7,
  commitSha: 'abcdef1234567890',
  model: 'gpt-6-luna',
  source: 'replay_benchmark',
  status: 'success',
  workflowRunId: null,
  webhookPayload: null,
  input: {},
  result: {
    assessment: 'approve',
    findings: [],
    inlineComments: [],
    skipped: 0,
  },
  comparisonResult: null,
  error: null,
  durationMs: 1500,
  createdAt: new Date('2026-10-01T10:00:00.000Z'),
  completedAt: null,
  ...overrides,
})

const columnValue = (lines: string[], column: string): string => {
  const [header = '', row = ''] = lines
  const start = header.indexOf(column)
  const nextColumn = header.slice(start).search(/ {2}\S/)
  return row.slice(start, start + nextColumn).trim()
}

describe('parseRunsArgs', () => {
  test.each([[['--help']], [['-h']], [['demo', '--help']]])('returns help for %p', (args) => {
    expect(parseRunsArgs(args)).toEqual({ kind: 'help' })
  })

  test('parses project key and mr iid', () => {
    expect(parseRunsArgs(['demo', '7'])).toEqual({ kind: 'list', projectKey: 'demo', mrIid: 7 })
  })

  test('rejects unknown flags and extra arguments', () => {
    expect(parseRunsArgs(['--verbose'])).toEqual({ kind: 'invalid' })
    expect(parseRunsArgs(['demo', '7', 'extra'])).toEqual({ kind: 'invalid' })
  })
})

describe('formatRunsTable', () => {
  test('shows the run source in SRC', () => {
    const lines = formatRunsTable([run()])

    expect(columnValue(lines, 'SRC')).toBe('replay_benchmark')
  })
})
