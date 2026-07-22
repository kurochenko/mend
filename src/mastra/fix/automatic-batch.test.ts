import { describe, expect, test } from 'bun:test'
import type { ProjectConfig } from '@/config'
import type { FixBatchRecord } from '@/db/fix-batches'
import type { ReviewFindingRecord } from '@/db/review-findings'
import { queueAutomaticFixBatch } from '@/mastra/fix/automatic-batch'

const now = new Date('2026-06-04T00:00:00Z')

const makeProject = (fix: Partial<ProjectConfig['review']['fix']> = {}): ProjectConfig => ({
  key: 'demo',
  platform: 'gitlab',
  url: 'https://gitlab.com',
  token: 'token',
  webhook_secret: 'secret',
  project_id: 123,
  repo_url: 'git@gitlab.com:org/repo.git',
  default_branch: 'main',
  trigger: { mode: 'ready' },
  clone_path: '/tmp/demo.git',
  tools: { context7: {} },
  review: {
    llm: { model: 'review-model', thinking_level: 'medium' },
    agent: { harness: 'codex', model: 'review-agent-model', thinking_level: 'low' },
    template: { prompt: 'auto', label_prefix: 'ai-review:' },
    flags: {
      prompt_templates_v2: true,
      schema_v2: true,
      structured_findings_post: true,
      structural_signals: true,
      bug_history: true,
      dry_run: false,
    },
    intent: {
      harness: 'pi',
      model: 'intent-model',
      thinking_level: 'minimal',
      timeout_ms: 45_000,
      failure_policy: 'mixed',
    },
    comparison: { enabled: false, harness: 'opencode', timeout_ms: 300_000 },
    memory: { project_scope_usernames: [] },
    triage: { trusted_usernames: [] },
    fix: {
      enabled: true,
      automatic: true,
      max_loops: 3,
      ...fix,
    },
  },
})

const makeBatch = (overrides: Partial<FixBatchRecord> = {}): FixBatchRecord => ({
  id: 'demo:42',
  projectKey: 'demo',
  mrIid: 42,
  status: 'pending',
  force: true,
  loopCount: 0,
  requestNoteId: null,
  requestThreadId: null,
  requestedByExternalId: null,
  requestedByName: null,
  acceptedFindingIds: ['finding-1'],
  pendingFindingIds: [],
  sourceBranch: null,
  pushedCommitSha: null,
  result: null,
  failureMessage: null,
  createdAt: now,
  updatedAt: now,
  ...overrides,
})

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
  decisionReason: null,
  decidedByExternalId: null,
  decidedByName: null,
  decidedAt: null,
  metadata: null,
  createdAt: now,
  updatedAt: now,
})

describe('queueAutomaticFixBatch', () => {
  test('does nothing unless both fix loop and automatic mode are enabled', async () => {
    const outcome = await queueAutomaticFixBatch({
      project: makeProject({ enabled: false, automatic: true }),
      mrIid: 42,
    })

    expect(outcome).toEqual({ status: 'disabled' })
  })

  test('queues only pending and accepted findings, preserving human decisions', async () => {
    const upsertCalls: unknown[] = []
    const outcome = await queueAutomaticFixBatch({
      project: makeProject(),
      mrIid: 42,
      dependencies: {
        getExistingBatch: async () => null,
        listFindings: async () => [
          makeFinding('pending-1', 'pending'),
          makeFinding('accepted-1', 'accepted'),
          makeFinding('rejected-1', 'rejected'),
          makeFinding('deferred-1', 'deferred'),
          makeFinding('fixed-1', 'fixed'),
          makeFinding('resolved-1', 'resolved'),
        ],
        upsertBatch: async (params) => {
          upsertCalls.push(params)
          return makeBatch({ acceptedFindingIds: params.acceptedFindingIds })
        },
      },
    })

    expect(outcome).toEqual(
      expect.objectContaining({
        status: 'queued',
        queuedCount: 2,
        ignoredCount: 4,
      }),
    )
    expect(upsertCalls).toEqual([
      expect.objectContaining({
        force: true,
        acceptedFindingIds: ['pending-1', 'accepted-1'],
        pendingFindingIds: [],
        resetLoopCount: false,
      }),
    ])
  })

  test('does not queue when a batch is already pending or running', async () => {
    const existing = makeBatch({ status: 'running', loopCount: 1 })

    const outcome = await queueAutomaticFixBatch({
      project: makeProject(),
      mrIid: 42,
      dependencies: {
        getExistingBatch: async () => existing,
        listFindings: async () => {
          throw new Error('should not list findings')
        },
      },
    })

    expect(outcome).toEqual({ status: 'duplicate', batch: existing })
  })

  test('stops when the existing fix loop reached the configured limit', async () => {
    const existing = makeBatch({ status: 'completed', loopCount: 3 })

    const outcome = await queueAutomaticFixBatch({
      project: makeProject({ max_loops: 3 }),
      mrIid: 42,
      dependencies: {
        getExistingBatch: async () => existing,
        listFindings: async () => [makeFinding('pending-1', 'pending')],
      },
    })

    expect(outcome).toEqual({ status: 'loop_limit', batch: existing, maxLoops: 3 })
  })

  test('does not automatically requeue a failed batch after a commit was pushed', async () => {
    const existing = makeBatch({
      status: 'failed',
      loopCount: 1,
      pushedCommitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    })

    const outcome = await queueAutomaticFixBatch({
      project: makeProject({ max_loops: 3 }),
      mrIid: 42,
      dependencies: {
        getExistingBatch: async () => existing,
        listFindings: async () => {
          throw new Error('should not list findings')
        },
      },
    })

    expect(outcome).toEqual({ status: 'duplicate', batch: existing })
  })

  test('returns no_findings when posted findings are already terminal or human-rejected', async () => {
    const outcome = await queueAutomaticFixBatch({
      project: makeProject(),
      mrIid: 42,
      dependencies: {
        getExistingBatch: async () => null,
        listFindings: async () => [
          makeFinding('rejected-1', 'rejected'),
          makeFinding('deferred-1', 'deferred'),
        ],
      },
    })

    expect(outcome).toEqual({ status: 'no_findings', consideredCount: 2 })
  })
})
