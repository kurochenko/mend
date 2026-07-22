import { describe, expect, test } from 'bun:test'
import type { ProjectConfig } from '@/config'
import type { ReviewFindingRecord } from '@/db/review-findings'
import type { DiscussionNote } from '@/integrations/gitlab/discussions'
import {
  applyFixerFindingStates,
  type FixerFindingStateDependencies,
} from '@/mastra/fix/finding-state'
import type { FixerOutput } from '@/mastra/fix/schema'

const now = new Date('2026-06-04T00:00:00Z')

const makeProject = (): ProjectConfig => ({
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
      automatic: false,
      max_loops: 3,
      workspace: {
        provider: 'docker',
        image: 'alpine:3.20',
        network: 'none',
        env: {},
        mounts: [],
        setup: [],
        checks: [],
      },
    },
  },
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

const makeReply = (body: string): DiscussionNote => ({
  id: 99,
  body,
  author: { id: 7, username: 'mend-bot', raw: { id: 7 } },
  resolvable: true,
  raw: { id: 99 },
})

const makeOutput = (overrides: Partial<FixerOutput> = {}): FixerOutput => ({
  version: 'fixer-v1',
  summary: 'Handled findings',
  fixedFindings: [{ id: 'fixed-1', summary: 'Added guard' }],
  notFixedFindings: [{ id: 'not-fixed-1', reason: 'Needs product decision' }],
  changedFiles: ['src/app.ts'],
  checksRun: [{ command: 'bun test', status: 'passed', summary: 'ok' }],
  errors: [],
  ...overrides,
})

const makeDependencies = (): FixerFindingStateDependencies & {
  calls: {
    updates: Array<{
      id: string
      state: ReviewFindingRecord['state']
      reason: string | null | undefined
    }>
    replies: Array<{ providerThreadId: string; body: string }>
    storedReplies: string[]
  }
} => {
  const calls = {
    updates: [] as Array<{
      id: string
      state: ReviewFindingRecord['state']
      reason: string | null | undefined
    }>,
    replies: [] as Array<{ providerThreadId: string; body: string }>,
    storedReplies: [] as string[],
  }

  return {
    calls,
    listFindings: async () => [
      makeFinding('fixed-1', 'accepted'),
      makeFinding('not-fixed-1', 'accepted'),
    ],
    updateFinding: async (params) => {
      calls.updates.push({
        id: params.id,
        state: params.state,
        reason: params.decisionReason,
      })
      return makeFinding(params.id, params.state)
    },
    reply: async (params) => {
      calls.replies.push({
        providerThreadId: params.providerThreadId,
        body: params.body,
      })
      return makeReply(params.body)
    },
    storeReply: async (params) => {
      calls.storedReplies.push(params.finding.id)
    },
  }
}

describe('applyFixerFindingStates', () => {
  test('marks fixed findings and replies to not-fixed findings without resolving them', async () => {
    const dependencies = makeDependencies()

    await applyFixerFindingStates({
      project: makeProject(),
      projectKey: 'demo',
      mrIid: 42,
      fixerOutput: makeOutput(),
      dependencies,
    })

    expect(dependencies.calls.updates).toEqual([
      { id: 'fixed-1', state: 'fixed', reason: 'Added guard' },
      { id: 'not-fixed-1', state: 'not_fixed', reason: 'Needs product decision' },
    ])
    expect(dependencies.calls.replies).toEqual([
      {
        providerThreadId: 'discussion-not-fixed-1',
        body: 'Mend fixer could not fix this finding: Needs product decision',
      },
    ])
    expect(dependencies.calls.storedReplies).toEqual(['not-fixed-1'])
  })

  test('rejects unknown fixer finding ids before mutating state', async () => {
    const dependencies = makeDependencies()

    await expect(
      applyFixerFindingStates({
        project: makeProject(),
        projectKey: 'demo',
        mrIid: 42,
        fixerOutput: makeOutput({
          fixedFindings: [{ id: 'missing', summary: 'Changed code' }],
          notFixedFindings: [],
        }),
        dependencies,
      }),
    ).rejects.toThrow('unknown fixed finding missing')

    expect(dependencies.calls.updates).toEqual([])
    expect(dependencies.calls.replies).toEqual([])
  })

  test('rejects fixer output that reports the same finding as fixed and not fixed', async () => {
    const dependencies = makeDependencies()

    await expect(
      applyFixerFindingStates({
        project: makeProject(),
        projectKey: 'demo',
        mrIid: 42,
        fixerOutput: makeOutput({
          fixedFindings: [{ id: 'fixed-1', summary: 'Changed code' }],
          notFixedFindings: [{ id: 'fixed-1', reason: 'Still unclear' }],
        }),
        dependencies,
      }),
    ).rejects.toThrow('both fixed and not fixed')

    expect(dependencies.calls.updates).toEqual([])
    expect(dependencies.calls.replies).toEqual([])
  })
})
