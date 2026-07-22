import { describe, expect, test } from 'bun:test'

const { renderStatusNoteBody } = await import('./status-note-body')

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

describe('buildStatusNoteBody', () => {
  test('renders title, updated line, and full run history with queued row', async () => {
    const body = renderStatusNoteBody({
      input: {
        state: 'running',
        event: makeEvent(),
        runningSha: '1234567890abcdef',
        pendingSha: 'fedcba0987654321',
        reviewMode: 'update',
        previousReviewedSha: 'abcdef1234567890',
        message: 'Review is in progress; newer update queued',
      },
      reviewRuns: [
        {
          id: 'run-current',
          projectKey: 'cookt',
          mrIid: 42,
          commitSha: '1234567890abcdef',
          model: 'test-model',
          source: 'webhook',
          status: 'running',
          workflowRunId: 'wf-1',
          webhookPayload: null,
          input: {},
          result: null,
          comparisonResult: null,
          error: null,
          durationMs: null,
          createdAt: new Date('2026-03-07T18:42:00.000Z'),
          completedAt: null,
        },
        {
          id: 'run-previous',
          projectKey: 'cookt',
          mrIid: 42,
          commitSha: 'abcdef1234567890',
          model: 'test-model',
          source: 'webhook',
          status: 'success',
          workflowRunId: 'wf-0',
          webhookPayload: null,
          input: {},
          result: {
            assessment: 'approve',
            findings: [{ severity: 'bug' }],
            inlineComments: [{ severity: 'suggestion' }],
          },
          comparisonResult: null,
          error: null,
          durationMs: 12_500,
          createdAt: new Date('2026-03-07T18:30:00.000Z'),
          completedAt: new Date('2026-03-07T18:30:12.500Z'),
        },
      ],
      updatedAt: '2026-03-07T19:00:00.000Z',
    })

    expect(body).toContain('## Mend Status')
    expect(body).toContain('Updated 2026-03-07 19:00 UTC')
    expect(body).not.toContain('| Status | SHA | Mode | Updated |')
    expect(body).toContain('Review is in progress; newer update queued')
    expect(body).toContain('| Slot | SHA | Outcome | Assessment | Findings | Started | Duration |')
    expect(body).toContain('| Queued | `fedcba09` | 🕒 Pending | - | — | - | - |')
    expect(body).toContain('| Current | `12345678` | ⏳ Running | - | — | - | - |')
    expect(body).not.toContain('| Previous | `12345678` | ⏳ Running |')
    expect(body).toContain(
      '| Previous | `abcdef12` | ✅ Completed | Approve | 2 (1🐞 1💡) | 2026-03-07 18:30 UTC | 12.5s |',
    )
    expect(body).toContain('| Previous reviewed SHA | `abcdef12` |')
  })

  test('renders synthetic current row for no-change updates without a persisted run', async () => {
    const body = renderStatusNoteBody({
      input: {
        state: 'no_change',
        event: makeEvent(),
        runningSha: '1111111122222222',
        reviewMode: 'update',
        previousReviewedSha: 'abcdef1234567890',
        message: 'Latest SHA already reviewed successfully; skipping duplicate event',
      },
      reviewRuns: [
        {
          id: 'run-previous',
          projectKey: 'cookt',
          mrIid: 42,
          commitSha: '1111111122222222',
          model: 'test-model',
          source: 'webhook',
          status: 'success',
          workflowRunId: 'wf-0',
          webhookPayload: null,
          input: {},
          result: { assessment: 'request_changes' },
          comparisonResult: null,
          error: null,
          durationMs: 8_000,
          createdAt: new Date('2026-03-07T18:30:00.000Z'),
          completedAt: new Date('2026-03-07T18:30:08.000Z'),
        },
      ],
      updatedAt: '2026-03-07T19:00:00.000Z',
    })

    expect(body).toContain('Updated 2026-03-07 19:00 UTC')
    expect(body).toContain('| Current | `11111111` | ⏭️ No changes | - | — | - | - |')
    expect(body).toContain(
      '| Previous | `11111111` | ✅ Completed | Request changes | — | 2026-03-07 18:30 UTC | 8s |',
    )
  })

  test('keeps current failed attempts synthetic when an older failed run has the same sha', async () => {
    const body = renderStatusNoteBody({
      input: {
        state: 'failed',
        event: makeEvent(),
        runningSha: '2222222233333333',
        reviewMode: 'update',
        message: 'Review crashed before the run record was updated',
      },
      reviewRuns: [
        {
          id: 'run-previous-failed',
          projectKey: 'cookt',
          mrIid: 42,
          commitSha: '2222222233333333',
          model: 'test-model',
          source: 'webhook',
          status: 'failed',
          workflowRunId: 'wf-old',
          webhookPayload: null,
          input: {},
          result: null,
          comparisonResult: null,
          error: 'old failure',
          durationMs: 5_000,
          createdAt: new Date('2026-03-07T18:10:00.000Z'),
          completedAt: new Date('2026-03-07T18:10:05.000Z'),
        },
      ],
      updatedAt: '2026-03-07T19:00:00.000Z',
    })

    expect(body).toContain('| Current | `22222222` | ❌ Failed | - | — | - | - |')
    expect(body).toContain(
      '| Previous | `22222222` | ❌ Failed | - | — | 2026-03-07 18:10 UTC | 5s |',
    )
  })

  test('caps persisted history rows in the note body', async () => {
    const body = renderStatusNoteBody({
      input: {
        state: 'completed',
        event: makeEvent(),
        runningSha: 'aaaaaaaaaaaaaaa0',
        reviewMode: 'update',
        runId: 'run-0',
        message: 'Completed with assessment approve',
      },
      reviewRuns: Array.from({ length: 16 }, (_value, index) => ({
        id: `run-${index}`,
        projectKey: 'cookt',
        mrIid: 42,
        commitSha: `${index}`.padStart(16, 'a'),
        model: 'test-model',
        source: 'webhook',
        status: 'success',
        workflowRunId: `wf-${index}`,
        webhookPayload: null,
        input: {},
        result: { assessment: 'approve' },
        comparisonResult: null,
        error: null,
        durationMs: 1_000,
        createdAt: new Date(`2026-03-07T18:${String(index).padStart(2, '0')}:00.000Z`),
        completedAt: new Date(`2026-03-07T18:${String(index).padStart(2, '0')}:01.000Z`),
      })),
      updatedAt: '2026-03-07T19:00:00.000Z',
    })

    expect(body).toContain('Showing the latest 15 persisted runs.')
    expect(body).not.toContain('2026-03-07 18:15 UTC')
  })

  test('rounds minute durations without emitting 60 seconds', async () => {
    const body = renderStatusNoteBody({
      input: {
        state: 'completed',
        event: makeEvent(),
        runningSha: '3333333344444444',
        reviewMode: 'update',
        runId: 'run-duration',
        message: 'Completed with assessment approve',
      },
      reviewRuns: [
        {
          id: 'run-duration',
          projectKey: 'cookt',
          mrIid: 42,
          commitSha: '3333333344444444',
          model: 'test-model',
          source: 'webhook',
          status: 'success',
          workflowRunId: 'wf-duration',
          webhookPayload: null,
          input: {},
          result: { assessment: 'approve' },
          comparisonResult: null,
          error: null,
          durationMs: 119_600,
          createdAt: new Date('2026-03-07T18:40:00.000Z'),
          completedAt: new Date('2026-03-07T18:41:59.600Z'),
        },
      ],
      updatedAt: '2026-03-07T19:00:00.000Z',
    })

    expect(body).toContain(
      '| Current | `33333333` | ✅ Completed | Approve | — | 2026-03-07 18:40 UTC | 2m |',
    )
    expect(body).not.toContain('60s')
  })

  test('renders finding decision counts when present', async () => {
    const body = renderStatusNoteBody({
      input: {
        state: 'completed',
        event: makeEvent(),
        runningSha: '3333333344444444',
        reviewMode: 'update',
        runId: 'run-duration',
      },
      reviewRuns: [],
      findingStateCounts: {
        pending: 2,
        accepted: 3,
        rejected: 1,
        deferred: 1,
      },
      updatedAt: '2026-03-07T19:00:00.000Z',
    })

    expect(body).toContain('### Finding Decisions')
    expect(body).toContain(
      '| Pending | Accepted | Rejected | Deferred | Fixed | Not fixed | Resolved |',
    )
    expect(body).toContain('| ---: | ---: | ---: | ---: | ---: | ---: | ---: |')
    expect(body).toContain('| 2 | 3 | 1 | 1 | 0 | 0 | 0 |')
  })

  test('renders ensemble review configuration with thinking levels when present', async () => {
    const body = renderStatusNoteBody({
      input: {
        state: 'running',
        event: makeEvent(),
        runningSha: '3333333344444444',
        message: 'Review is in progress',
      },
      reviewRuns: [],
      reviewConfig: {
        harness: 'ensemble',
        stages: [
          { label: 'Finder', model: 'gpt-5.6-terra', thinking: 'low' },
          { label: 'Verify', model: 'gpt-5.6-terra', thinking: 'low' },
          { label: 'Deep', model: 'gpt-5.6-sol' },
          { label: 'Synth', model: 'gpt-5.6-terra' },
        ],
      },
      updatedAt: '2026-03-07T19:00:00.000Z',
    })

    expect(body).toContain(
      '**Review:** ensemble · Finder `gpt-5.6-terra` (low) · Verify `gpt-5.6-terra` (low) · Deep `gpt-5.6-sol` · Synth `gpt-5.6-terra`',
    )
    expect(body).not.toContain('Deep `gpt-5.6-sol` (')
    expect(body).not.toContain('Synth `gpt-5.6-terra` (')
    expect(body.indexOf('Review is in progress')).toBeLessThan(body.indexOf('**Review:**'))
  })

  test('renders tracked MR finding severities and omits them without findings', async () => {
    const input = {
      state: 'completed' as const,
      event: makeEvent(),
      runningSha: '3333333344444444',
      runId: 'run-findings',
    }

    const body = renderStatusNoteBody({
      input,
      reviewRuns: [],
      findingSeverityCounts: {
        bug: 2,
        security: 1,
        performance: 0,
        suggestion: 1,
      },
      findingStateCounts: { pending: 1 },
      updatedAt: '2026-03-07T19:00:00.000Z',
    })
    const bodyWithoutFindings = renderStatusNoteBody({
      input,
      reviewRuns: [],
      findingSeverityCounts: {
        bug: 0,
        security: 0,
        performance: 0,
        suggestion: 0,
      },
      updatedAt: '2026-03-07T19:00:00.000Z',
    })

    expect(body).toContain('**Findings by severity (tracked on MR):** 4 · 2🐞 1🔒 0⚡ 1💡')
    expect(body.indexOf('**Findings by severity (tracked on MR):**')).toBeLessThan(
      body.indexOf('### Finding Decisions'),
    )
    expect(bodyWithoutFindings).not.toContain('**Findings by severity (tracked on MR):**')
  })
})
