import { describe, expect, mock, test } from 'bun:test'
import type { ProjectConfig } from '@/config'
import type { FixBatchRecord } from '@/db/fix-batches'
import type { ReviewFindingRecord } from '@/db/review-findings'
import type { PreparedFixWorkspace, WorkspaceCommandResult } from '@/fix-workspaces/types'
import type { FixerOutput } from '@/mastra/fix/schema'
import { ensureFixBatchRunner } from '@/server/fix-batch-runner'

const now = new Date('2026-06-04T00:00:00Z')

const makeBatch = (): FixBatchRecord => ({
  id: 'demo:42',
  projectKey: 'demo',
  mrIid: 42,
  status: 'pending',
  force: false,
  loopCount: 0,
  requestNoteId: 'note-1',
  requestThreadId: 'thread-1',
  requestedByExternalId: 'user-1',
  requestedByName: 'Reviewer',
  acceptedFindingIds: ['finding-1'],
  pendingFindingIds: [],
  sourceBranch: null,
  pushedCommitSha: null,
  result: null,
  failureMessage: null,
  createdAt: now,
  updatedAt: now,
})

const makeFinding = (): ReviewFindingRecord => ({
  id: 'finding-1',
  projectKey: 'demo',
  mrIid: 42,
  reviewRunId: 'run-1',
  threadId: 'thread-1',
  provider: 'gitlab',
  providerThreadId: 'discussion-1',
  providerNoteId: 'note-1',
  state: 'accepted',
  decisionReason: null,
  decidedByExternalId: null,
  decidedByName: null,
  decidedAt: null,
  metadata: { title: 'Finding' },
  createdAt: now,
  updatedAt: now,
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
  setupResults: [commandResult('setup')],
  runCommand: async () => commandResult('command'),
  runAgentCommand: async () => commandResult('agent'),
  runChecks: async () => [commandResult('check')],
  teardown: mock(async () => {}),
})

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
      agent: { harness: 'codex', model: 'gpt-5.5', thinking_level: 'medium' },
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

const output: FixerOutput = {
  version: 'fixer-v1',
  summary: 'Fixed finding',
  fixedFindings: [{ id: 'finding-1', summary: 'done' }],
  notFixedFindings: [],
  changedFiles: ['src/app.ts'],
  checksRun: [],
  errors: [],
}

describe('ensureFixBatchRunner', () => {
  test('does not start a fix worker while service is draining', async () => {
    const listRunnableFixBatches = mock(async () => [makeBatch()])

    const started = await ensureFixBatchRunner({
      mastra: {} as never,
      project: makeProject(),
      mrIid: 42,
      dependencies: {
        getServiceRuntimeMode: mock(async () => 'draining' as const),
        listRunnableFixBatches,
      },
    })

    expect(started).toBe(false)
    expect(listRunnableFixBatches).not.toHaveBeenCalled()
  })

  test('runs a pending fix batch through workspace, fixer, and completion', async () => {
    const batch = makeBatch()
    const workspace = makeWorkspace()
    let runnableCalls = 0
    let resolveCompleted: () => void = () => {}
    const completed = new Promise<void>((resolve) => {
      resolveCompleted = resolve
    })
    const startFixBatchRun = mock(async () => ({
      ...batch,
      status: 'running' as const,
      loopCount: 1,
    }))
    const failFixBatchRun = mock(async () => ({ ...batch, status: 'failed' as const }))
    const prepare = mock(async () => workspace)
    const runFixerAgent = mock(async () => ({
      output,
      rawOutput: JSON.stringify(output),
      harness: 'codex' as const,
      model: 'gpt-5.5',
      durationMs: 1,
      logs: [commandResult('agent')],
    }))
    const completeFixBatch = mock(async () => {
      resolveCompleted()
      return {
        batch: { ...batch, status: 'completed' as const },
        commit: {
          commitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          pushedBranch: 'feature/fix',
          remoteHeadSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
      }
    })

    const started = await ensureFixBatchRunner({
      mastra: {} as never,
      project: makeProject(),
      mrIid: 42,
      dependencies: {
        listRunnableFixBatches: mock(async () => {
          runnableCalls += 1
          return runnableCalls <= 2 ? [batch] : []
        }),
        startFixBatchRun,
        failFixBatchRun,
        getReviewQueueRecord: mock(async () => null),
        listReviewFindingsForMr: mock(async () => [makeFinding()]),
        createFixWorkspaceProvider: mock(() => ({ kind: 'docker' as const, prepare })),
        fetchMr: mock(async () => ({
          title: 'MR',
          description: '',
          labels: [],
          sourceBranch: 'feature/fix',
          targetBranch: 'main',
          url: 'https://gitlab.com/org/repo/-/merge_requests/42',
          sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        })),
        ensureClone: mock(async () => '/tmp/demo.git'),
        createWorktree: mock(async () => '/tmp/worktree'),
        removeWorktree: mock(async () => {}),
        runFixerAgent,
        completeFixBatch,
        enqueueMrReview: mock(async () => {}),
        getServiceRuntimeMode: mock(async () => 'running' as const),
      },
    })

    expect(started).toBe(true)
    await completed
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(startFixBatchRun).toHaveBeenCalled()
    expect(prepare).toHaveBeenCalled()
    expect(runFixerAgent).toHaveBeenCalled()
    expect(completeFixBatch).toHaveBeenCalled()
    expect(workspace.teardown).toHaveBeenCalled()
    expect(failFixBatchRun).not.toHaveBeenCalled()
  })
})
