import { describe, expect, test } from 'bun:test'
import type { FixBatchRecord } from '@/db/fix-batches'
import { renderStatusNoteBody } from '@/server/status-note-body'

const makeEvent = () => ({
  projectKey: 'cookt',
  mrIid: 42,
  title: 'Add status notes',
  description: '',
  labels: [],
  sourceBranch: 'feature/status-note',
  targetBranch: 'main',
  url: 'https://gitlab.com/cooktapp/cookt-app/-/merge_requests/42',
})

const makeFixBatch = (overrides: Partial<FixBatchRecord> = {}): FixBatchRecord => ({
  id: 'cookt:42',
  projectKey: 'cookt',
  mrIid: 42,
  status: 'running',
  force: false,
  loopCount: 2,
  requestNoteId: 'note-1',
  requestThreadId: 'thread-1',
  requestedByExternalId: 'user-1',
  requestedByName: 'Reviewer',
  acceptedFindingIds: ['finding-1', 'finding-2'],
  pendingFindingIds: [],
  sourceBranch: 'feature/status-note',
  pushedCommitSha: null,
  result: null,
  failureMessage: null,
  createdAt: new Date('2026-03-07T18:00:00.000Z'),
  updatedAt: new Date('2026-03-07T18:10:00.000Z'),
  ...overrides,
})

describe('renderStatusNoteBody', () => {
  test('renders active fix batch state when present', () => {
    const body = renderStatusNoteBody({
      input: {
        state: 'completed',
        event: makeEvent(),
        runningSha: '3333333344444444',
        reviewMode: 'update',
        runId: 'run-duration',
      },
      reviewRuns: [],
      fixBatch: makeFixBatch({
        status: 'running',
        loopCount: 2,
      }),
      updatedAt: '2026-03-07T19:00:00.000Z',
    })

    expect(body).toContain('### Fix Batch')
    expect(body).toContain('| Status | ⏳ Running |')
    expect(body).toContain('| Loop | 2 |')
    expect(body).toContain('| Findings | 2 |')
  })

  test('renders completed fix batch push metadata', () => {
    const body = renderStatusNoteBody({
      input: {
        state: 'completed',
        event: makeEvent(),
        runningSha: '3333333344444444',
        reviewMode: 'update',
        runId: 'run-duration',
      },
      reviewRuns: [],
      fixBatch: makeFixBatch({
        status: 'completed',
        pushedCommitSha: 'abcdef1234567890',
      }),
      updatedAt: '2026-03-07T19:00:00.000Z',
    })

    expect(body).toContain('| Status | ✅ Completed |')
    expect(body).toContain('| Pushed commit | `abcdef12` |')
  })

  test('counts pending findings captured in the fix batch', () => {
    const body = renderStatusNoteBody({
      input: {
        state: 'completed',
        event: makeEvent(),
        runningSha: '3333333344444444',
      },
      reviewRuns: [],
      fixBatch: makeFixBatch({
        acceptedFindingIds: ['accepted-1'],
        pendingFindingIds: ['pending-1', 'pending-2'],
      }),
      updatedAt: '2026-03-07T19:00:00.000Z',
    })

    expect(body).toContain('| Findings | 3 |')
  })
})
