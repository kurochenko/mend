import { describe, expect, test } from 'bun:test'
import type { GitLabProjectConfig } from '@/config'
import type { FixBatchRecord } from '@/db/fix-batches'
import type { PreparedFixWorkspace, WorkspaceCommandResult } from '@/fix-workspaces/types'
import {
  assertFixBatchSourceBranch,
  completeFixBatch,
  type FixBatchCommitPushResult,
  type FixBatchCompletionDependencies,
  type FixBatchMrContext,
} from '@/mastra/fix/commit-push'
import type { FixerOutput } from '@/mastra/fix/schema'

const now = new Date('2026-06-04T00:00:00Z')

const makeProject = (overrides: Partial<GitLabProjectConfig> = {}): GitLabProjectConfig => ({
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
      enabled: false,
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
  ...overrides,
})

const makeBatch = (overrides: Partial<FixBatchRecord> = {}): FixBatchRecord => ({
  id: 'demo:42',
  projectKey: 'demo',
  mrIid: 42,
  status: 'pending',
  force: false,
  loopCount: 0,
  requestNoteId: 'note-request',
  requestThreadId: 'thread-request',
  requestedByExternalId: '1',
  requestedByName: 'andrej',
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

const commandResult = (phase: WorkspaceCommandResult['phase']): WorkspaceCommandResult => ({
  command: `echo ${phase}`,
  phase,
  exitCode: 0,
  stdout: '',
  stderr: '',
  durationMs: 1,
})

const makeWorkspace = (): PreparedFixWorkspace => ({
  id: 'workspace-1',
  provider: 'docker',
  hostWorktreePath: '/tmp/worktree',
  workspaceCwd: '/workspace',
  git: { mode: 'host', cwd: '/tmp/worktree' },
  setupResults: [],
  runCommand: async () => commandResult('command'),
  runAgentCommand: async () => commandResult('agent'),
  runChecks: async () => [commandResult('check')],
  teardown: async () => {},
})

const makeMr = (overrides: Partial<FixBatchMrContext> = {}): FixBatchMrContext => ({
  title: 'Fix MR',
  description: 'MR description',
  labels: ['feature'],
  sourceBranch: 'feature/fix',
  targetBranch: 'main',
  url: 'https://gitlab.com/org/repo/-/merge_requests/42',
  ...overrides,
})

const fixerOutput: FixerOutput = {
  version: 'fixer-v1',
  summary: 'Fixed one finding',
  fixedFindings: [{ id: 'finding-1', summary: 'Added guard' }],
  notFixedFindings: [],
  changedFiles: ['src/app.ts'],
  checksRun: [{ command: 'bun test', status: 'passed', summary: 'ok' }],
  errors: [],
}

const makeDependencies = (
  overrides: {
    start?: FixBatchCompletionDependencies['store']['start']
    complete?: FixBatchCompletionDependencies['store']['complete']
    fail?: FixBatchCompletionDependencies['store']['fail']
    recordPush?: FixBatchCompletionDependencies['store']['recordPush']
    commitAndPush?: FixBatchCompletionDependencies['git']['commitAndPush']
    enqueue?: FixBatchCompletionDependencies['review']['enqueue']
    applyFindingStates?: FixBatchCompletionDependencies['findingState']['apply']
  } = {},
): FixBatchCompletionDependencies & {
  calls: {
    started: number
    completed: number
    failed: number
    recordedPush: number
    pushed: number
    enqueued: number
    synced: number
  }
  completedResult: unknown
  recordedPushResult: unknown
  failedParams: unknown
  enqueuedCommitSha: string | null
} => {
  const calls = {
    started: 0,
    completed: 0,
    failed: 0,
    recordedPush: 0,
    pushed: 0,
    enqueued: 0,
    synced: 0,
  }
  let completedResult: unknown = null
  let recordedPushResult: unknown = null
  let failedParams: unknown = null
  let enqueuedCommitSha: string | null = null

  return {
    calls,
    get completedResult() {
      return completedResult
    },
    get recordedPushResult() {
      return recordedPushResult
    },
    get failedParams() {
      return failedParams
    },
    get enqueuedCommitSha() {
      return enqueuedCommitSha
    },
    store: {
      start:
        overrides.start ??
        (async () => {
          calls.started++
          return makeBatch({ status: 'running', loopCount: 1 })
        }),
      complete:
        overrides.complete ??
        (async (params) => {
          calls.completed++
          completedResult = params.result
          return makeBatch({
            status: 'completed',
            sourceBranch: params.sourceBranch,
            pushedCommitSha: params.pushedCommitSha,
            result: params.result,
          })
        }),
      fail:
        overrides.fail ??
        (async (params) => {
          calls.failed++
          failedParams = params
          return makeBatch({ status: 'failed' })
        }),
      recordPush:
        overrides.recordPush ??
        (async (params) => {
          calls.recordedPush++
          recordedPushResult = params.result
          return makeBatch({
            status: 'running',
            sourceBranch: params.sourceBranch,
            pushedCommitSha: params.pushedCommitSha,
            result: params.result,
          })
        }),
    },
    git: {
      commitAndPush:
        overrides.commitAndPush ??
        (async () => {
          calls.pushed++
          return {
            commitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            pushedBranch: 'feature/fix',
            remoteHeadSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          }
        }),
    },
    review: {
      enqueue:
        overrides.enqueue ??
        (async (params) => {
          calls.enqueued++
          enqueuedCommitSha = params.commitSha
        }),
    },
    findingState: {
      apply:
        overrides.applyFindingStates ??
        (async () => {
          calls.synced++
        }),
    },
  }
}

const runComplete = async (
  dependencies: FixBatchCompletionDependencies,
  mr: FixBatchMrContext = makeMr(),
) =>
  await completeFixBatch({
    project: makeProject(),
    batch: makeBatch(),
    mr,
    workspace: makeWorkspace(),
    fixerOutput,
    dependencies,
  })

describe('assertFixBatchSourceBranch', () => {
  test('refuses protected and refspec-shaped branches', () => {
    const project = makeProject({ default_branch: 'develop' })

    expect(() => assertFixBatchSourceBranch(project, 'main', 'develop')).toThrow('protected branch')
    expect(() => assertFixBatchSourceBranch(project, 'trunk', 'develop')).toThrow(
      'protected branch',
    )
    expect(() => assertFixBatchSourceBranch(project, 'develop', 'main')).toThrow('protected branch')
    expect(() => assertFixBatchSourceBranch(project, 'refs/heads/feature', 'develop')).toThrow(
      'simple branch',
    )
    expect(() => assertFixBatchSourceBranch(project, 'feature:other', 'develop')).toThrow(
      'simple branch',
    )
  })
})

describe('completeFixBatch', () => {
  test('creates one commit, records it, and queues standard review', async () => {
    const dependencies = makeDependencies()

    const result = await runComplete(dependencies)

    expect(result.commit).toEqual({
      commitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      pushedBranch: 'feature/fix',
      remoteHeadSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    })
    expect(dependencies.calls).toEqual({
      started: 1,
      completed: 1,
      failed: 0,
      recordedPush: 1,
      pushed: 1,
      enqueued: 1,
      synced: 1,
    })
    expect(dependencies.enqueuedCommitSha).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    expect(dependencies.completedResult).toEqual(
      expect.objectContaining({
        version: 'fix-batch-v1',
        fixer: fixerOutput,
        review: { queued: true },
      }),
    )
  })

  test('enforces max loops before pushing', async () => {
    const dependencies = makeDependencies({
      start: async () => {
        throw new Error('Fix batch loop limit reached for demo MR !42: 3/3')
      },
    })

    await expect(runComplete(dependencies)).rejects.toThrow('loop limit reached')
    expect(dependencies.calls.pushed).toBe(0)
    expect(dependencies.calls.enqueued).toBe(0)
    expect(dependencies.calls.synced).toBe(0)
  })

  test('fails the batch when the push reports a different branch', async () => {
    const dependencies = makeDependencies({
      commitAndPush: async (): Promise<FixBatchCommitPushResult> => {
        dependencies.calls.pushed++
        return {
          commitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          pushedBranch: 'feature/other',
          remoteHeadSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        }
      },
    })

    await expect(runComplete(dependencies)).rejects.toThrow('expected source branch feature/fix')
    expect(dependencies.calls.failed).toBe(1)
    expect(dependencies.calls.completed).toBe(0)
    expect(dependencies.calls.enqueued).toBe(0)
    expect(dependencies.calls.synced).toBe(0)
  })

  test('fails the batch when the remote head does not match the pushed commit', async () => {
    const dependencies = makeDependencies({
      commitAndPush: async (): Promise<FixBatchCommitPushResult> => {
        dependencies.calls.pushed++
        return {
          commitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          pushedBranch: 'feature/fix',
          remoteHeadSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        }
      },
    })

    await expect(runComplete(dependencies)).rejects.toThrow('does not match commit')
    expect(dependencies.calls.failed).toBe(1)
    expect(dependencies.calls.completed).toBe(0)
    expect(dependencies.calls.enqueued).toBe(0)
    expect(dependencies.calls.synced).toBe(0)
  })

  test('queues review when fixer finding state sync fails after push', async () => {
    const dependencies = makeDependencies({
      applyFindingStates: async () => {
        dependencies.calls.synced++
        throw new Error('thread reply failed')
      },
    })

    const result = await runComplete(dependencies)

    expect(result.commit.commitSha).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    expect(dependencies.calls.completed).toBe(1)
    expect(dependencies.calls.failed).toBe(0)
    expect(dependencies.calls.recordedPush).toBe(1)
    expect(dependencies.calls.enqueued).toBe(1)
    expect(dependencies.calls.synced).toBe(1)
    expect(dependencies.completedResult).toEqual(
      expect.objectContaining({
        findingState: { error: 'thread reply failed' },
        review: { queued: true },
      }),
    )
  })

  test('completes the batch when follow-up review enqueue fails after push', async () => {
    const dependencies = makeDependencies({
      enqueue: async () => {
        dependencies.calls.enqueued++
        throw new Error('review queue failed')
      },
    })

    const result = await runComplete(dependencies)

    expect(result.commit.commitSha).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    expect(dependencies.calls.completed).toBe(1)
    expect(dependencies.calls.failed).toBe(0)
    expect(dependencies.calls.recordedPush).toBe(1)
    expect(dependencies.calls.enqueued).toBe(1)
    expect(dependencies.completedResult).toEqual(
      expect.objectContaining({
        findingState: { synced: true },
        review: { queued: false, error: 'review queue failed' },
      }),
    )
  })

  test('records pushed commit metadata when persistence fails after push', async () => {
    const dependencies = makeDependencies({
      recordPush: async () => {
        dependencies.calls.recordedPush++
        throw new Error('record push failed')
      },
    })

    await expect(runComplete(dependencies)).rejects.toThrow('record push failed')

    expect(dependencies.calls.pushed).toBe(1)
    expect(dependencies.calls.failed).toBe(1)
    expect(dependencies.calls.synced).toBe(0)
    expect(dependencies.calls.enqueued).toBe(0)
    expect(dependencies.failedParams).toEqual(
      expect.objectContaining({
        sourceBranch: 'feature/fix',
        pushedCommitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      }),
    )
  })

  test('refuses source branches that match the target branch before starting', async () => {
    const dependencies = makeDependencies()

    await expect(
      runComplete(
        dependencies,
        makeMr({ sourceBranch: 'feature/fix', targetBranch: 'feature/fix' }),
      ),
    ).rejects.toThrow('source and target branch are both feature/fix')
    expect(dependencies.calls.started).toBe(0)
    expect(dependencies.calls.pushed).toBe(0)
    expect(dependencies.calls.synced).toBe(0)
  })

  test('refuses protected source branches before starting', async () => {
    const dependencies = makeDependencies()

    await expect(
      runComplete(dependencies, makeMr({ sourceBranch: 'main', targetBranch: 'develop' })),
    ).rejects.toThrow('protected branch main')
    expect(dependencies.calls.started).toBe(0)
    expect(dependencies.calls.pushed).toBe(0)
    expect(dependencies.calls.synced).toBe(0)
  })
})
