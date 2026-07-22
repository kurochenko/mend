import { describe, expect, test } from 'bun:test'
import type { ProjectConfig } from '@/config'
import type { FixBatchRecord } from '@/db/fix-batches'
import type { ReviewFindingRecord } from '@/db/review-findings'
import type { FixerAgentHarness } from '@/agents/fixer-harness'
import type { PreparedFixWorkspace, WorkspaceCommandResult } from '@/fix-workspaces/types'
import {
  getEffectiveFixerAgentConfig,
  runFixerAgent,
  selectFixerFindings,
} from '@/mastra/fix/fixer-agent'

const now = new Date('2026-06-04T00:00:00Z')

const makeProject = (overrides: Partial<ProjectConfig['review']['fix']> = {}): ProjectConfig => ({
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
      agent: overrides.agent,
      enabled: overrides.enabled ?? false,
      automatic: overrides.automatic ?? false,
      max_loops: overrides.max_loops ?? 3,
      workspace: {
        provider: 'docker',
        image: 'alpine:3.20',
        network: 'none',
        env: {},
        mounts: [],
        setup: [],
        checks: ['bun test'],
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
  requestedByName: 'andrej',
  acceptedFindingIds: ['accepted-1', 'accepted-2'],
  pendingFindingIds: ['pending-1'],
  sourceBranch: null,
  pushedCommitSha: null,
  result: null,
  failureMessage: null,
  createdAt: now,
  updatedAt: now,
})

const makeWorkspace = (): PreparedFixWorkspace => ({
  id: 'workspace-1',
  provider: 'docker',
  hostWorktreePath: '/tmp/worktree',
  workspaceCwd: '/workspace',
  git: { mode: 'host', cwd: '/tmp/worktree' },
  setupResults: [],
  runCommand: async () => makeCommandResult('command'),
  runAgentCommand: async () => makeCommandResult('agent'),
  runChecks: async () => [makeCommandResult('check')],
  teardown: async () => {},
})

const makeCommandResult = (phase: WorkspaceCommandResult['phase']): WorkspaceCommandResult => ({
  command: `echo ${phase}`,
  phase,
  exitCode: 0,
  stdout: '',
  stderr: '',
  durationMs: 1,
})

describe('selectFixerFindings', () => {
  test('selects accepted batch findings as work and pending human decisions as context', () => {
    const result = selectFixerFindings({
      batch: makeBatch(),
      findings: [
        makeFinding('accepted-1', 'accepted'),
        makeFinding('accepted-2', 'accepted'),
        makeFinding('pending-1', 'pending'),
        makeFinding('deferred-1', 'deferred'),
        makeFinding('rejected-1', 'rejected'),
        makeFinding('fixed-1', 'fixed'),
      ],
    })

    expect(result.acceptedFindings.map((finding) => finding.id)).toEqual([
      'accepted-1',
      'accepted-2',
    ])
    expect(result.contextFindings.map((finding) => finding.id)).toEqual([
      'deferred-1',
      'rejected-1',
    ])
  })

  test('selects pending batch findings as automatic work items', () => {
    const batch = makeBatch()
    const result = selectFixerFindings({
      batch: {
        ...batch,
        acceptedFindingIds: ['pending-1'],
      },
      findings: [
        makeFinding('pending-1', 'pending'),
        makeFinding('rejected-1', 'rejected'),
        makeFinding('deferred-1', 'deferred'),
      ],
    })

    expect(result.acceptedFindings.map((finding) => finding.id)).toEqual(['pending-1'])
    expect(result.contextFindings.map((finding) => finding.id)).toEqual([
      'rejected-1',
      'deferred-1',
    ])
  })
})

describe('getEffectiveFixerAgentConfig', () => {
  test('defaults fixer harness to codex when no fix agent override is set', () => {
    expect(
      getEffectiveFixerAgentConfig({
        ...makeProject(),
        review: {
          ...makeProject().review,
          agent: { harness: 'pi', model: 'review-agent-model', thinking_level: 'low' },
        },
      }),
    ).toEqual({
      harness: 'codex',
      model: 'review-agent-model',
      thinkingLevel: 'low',
      timeoutMs: undefined,
    })
  })

  test('uses fix agent override when present', () => {
    expect(
      getEffectiveFixerAgentConfig(
        makeProject({
          agent: {
            harness: 'codex',
            model: 'gpt-5.5',
            thinking_level: 'medium',
            timeout_ms: 1_200_000,
          },
        }),
      ),
    ).toEqual({
      harness: 'codex',
      model: 'gpt-5.5',
      thinkingLevel: 'medium',
      timeoutMs: 1_200_000,
    })
  })
})

describe('runFixerAgent', () => {
  test('invokes fake harness with accepted findings and parses structured output', async () => {
    let capturedPrompt = ''
    const harness: FixerAgentHarness = {
      id: 'codex',
      invoke: async (config) => {
        capturedPrompt = config.prompt
        return {
          harness: 'codex',
          model: config.model,
          success: true,
          output: JSON.stringify({
            version: 'fixer-v1',
            summary: 'Fixed accepted finding',
            fixedFindings: [{ id: 'accepted-1', summary: 'Added guard' }],
            notFixedFindings: [{ id: 'accepted-2', reason: 'Needs owner input' }],
            changedFiles: ['src/app.ts'],
            checksRun: [{ command: 'bun test', status: 'passed', summary: 'ok' }],
            errors: [],
          }),
          durationMs: 12,
          logs: [makeCommandResult('agent')],
        }
      },
    }

    const result = await runFixerAgent({
      project: makeProject({ agent: { harness: 'codex', model: 'gpt-5.5' } }),
      batch: makeBatch(),
      findings: [
        makeFinding('accepted-1', 'accepted'),
        makeFinding('accepted-2', 'accepted'),
        makeFinding('pending-1', 'pending'),
        makeFinding('rejected-1', 'rejected'),
      ],
      workspace: makeWorkspace(),
      sessionDir: '/tmp/sessions',
      harnesses: { codex: harness },
    })

    expect(capturedPrompt).toContain('Findings to fix:')
    expect(capturedPrompt).toContain('id: accepted-1')
    expect(capturedPrompt).toContain('Context findings only. Do not fix these as work items:')
    expect(capturedPrompt).toContain('id: rejected-1')
    expect(capturedPrompt).toContain('- bun test')
    expect(result.output.fixedFindings[0]?.id).toBe('accepted-1')
    expect(result.output.notFixedFindings[0]?.id).toBe('accepted-2')
    expect(result.logs[0]?.phase).toBe('agent')
  })
})
