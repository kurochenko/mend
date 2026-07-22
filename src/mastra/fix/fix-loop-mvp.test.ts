import { describe, expect, test } from 'bun:test'
import type { ProjectConfig } from '@/config'
import type { FixBatchRecord } from '@/db/fix-batches'
import type { ReviewFindingRecord } from '@/db/review-findings'
import type { FixerAgentHarness } from '@/agents/fixer-harness'
import type { PreparedFixWorkspace, WorkspaceCommandResult } from '@/fix-workspaces/types'
import { completeFixBatch, type FixBatchCompletionDependencies } from '@/mastra/fix/commit-push'
import { runFixerAgent } from '@/mastra/fix/fixer-agent'

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
        setup: ['bun install --frozen-lockfile'],
        checks: ['bun run check'],
      },
    },
  },
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
  teardown: async () => {},
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
  metadata: { title: id, body: `${id} body` },
  createdAt: now,
  updatedAt: now,
})

const makeBatch = (): FixBatchRecord => ({
  id: 'demo:42',
  projectKey: 'demo',
  mrIid: 42,
  status: 'pending',
  force: false,
  loopCount: 0,
  requestNoteId: 'note-request',
  requestThreadId: 'thread-request',
  requestedByExternalId: '1',
  requestedByName: 'reviewer',
  acceptedFindingIds: ['finding-1', 'finding-2'],
  pendingFindingIds: [],
  sourceBranch: null,
  pushedCommitSha: null,
  result: null,
  failureMessage: null,
  createdAt: now,
  updatedAt: now,
})

const makeCompletionDependencies = (): FixBatchCompletionDependencies & {
  syncedFindingIds: string[]
  enqueuedCommitSha: string | null
} => {
  const batch = makeBatch()
  let enqueuedCommitSha: string | null = null
  const syncedFindingIds: string[] = []

  return {
    get syncedFindingIds() {
      return syncedFindingIds
    },
    get enqueuedCommitSha() {
      return enqueuedCommitSha
    },
    store: {
      start: async () => ({ ...batch, status: 'running', loopCount: 1 }),
      complete: async (params) => ({
        ...batch,
        status: 'completed',
        sourceBranch: params.sourceBranch,
        pushedCommitSha: params.pushedCommitSha,
        result: params.result,
      }),
      recordPush: async (params) => ({
        ...batch,
        status: 'running',
        sourceBranch: params.sourceBranch,
        pushedCommitSha: params.pushedCommitSha,
        result: params.result,
      }),
      fail: async () => ({ ...batch, status: 'failed' }),
    },
    git: {
      commitAndPush: async () => ({
        commitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        pushedBranch: 'feature/fix',
        remoteHeadSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      }),
    },
    review: {
      enqueue: async (params) => {
        enqueuedCommitSha = params.commitSha
      },
    },
    findingState: {
      apply: async (params) => {
        syncedFindingIds.push(
          ...params.fixerOutput.fixedFindings.map((finding) => finding.id),
          ...params.fixerOutput.notFixedFindings.map((finding) => finding.id),
        )
      },
    },
  }
}

describe('MVP fix loop with fakes', () => {
  test('runs fixer output through commit, state sync, and review queue without live services', async () => {
    const project = makeProject()
    const workspace = makeWorkspace()
    const harness: FixerAgentHarness = {
      id: 'codex',
      invoke: async () => ({
        harness: 'codex',
        model: 'gpt-5.5',
        success: true,
        output: JSON.stringify({
          version: 'fixer-v1',
          summary: 'Handled accepted findings',
          fixedFindings: [{ id: 'finding-1', summary: 'Added guard' }],
          notFixedFindings: [{ id: 'finding-2', reason: 'Needs product decision' }],
          changedFiles: ['src/app.ts'],
          checksRun: [{ command: 'bun run check', status: 'passed', summary: 'ok' }],
          errors: [],
        }),
        durationMs: 10,
        logs: [commandResult('agent')],
      }),
    }
    const dependencies = makeCompletionDependencies()

    const fixerResult = await runFixerAgent({
      project,
      batch: makeBatch(),
      findings: [makeFinding('finding-1', 'accepted'), makeFinding('finding-2', 'accepted')],
      workspace,
      sessionDir: '/tmp/mend-sessions',
      harnesses: { codex: harness },
    })
    const completion = await completeFixBatch({
      project,
      batch: makeBatch(),
      mr: {
        title: 'Fix MR',
        description: '',
        labels: [],
        sourceBranch: 'feature/fix',
        targetBranch: 'main',
        url: 'https://gitlab.com/org/repo/-/merge_requests/42',
      },
      workspace,
      fixerOutput: fixerResult.output,
      dependencies,
    })

    expect(fixerResult.output.fixedFindings.map((finding) => finding.id)).toEqual(['finding-1'])
    expect(dependencies.syncedFindingIds).toEqual(['finding-1', 'finding-2'])
    expect(completion.commit.commitSha).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    expect(dependencies.enqueuedCommitSha).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
  })
})
