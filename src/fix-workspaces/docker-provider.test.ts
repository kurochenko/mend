import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProjectConfig } from '@/config'
import { DockerFixWorkspaceProvider } from '@/fix-workspaces/docker-provider'

interface RecordedCall {
  command: string
  args: string[]
  options?: { env?: Record<string, string> }
}

const makeProject = (overrides: Partial<ProjectConfig['review']['fix']['workspace']> = {}) =>
  ({
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
      llm: { model: 'gpt-5', thinking_level: 'medium' },
      agent: { harness: 'pi' },
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
        model: 'gpt-5',
        thinking_level: 'minimal',
        timeout_ms: 45_000,
        failure_policy: 'mixed',
      },
      comparison: {
        enabled: false,
        harness: 'opencode',
        timeout_ms: 300_000,
      },
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
          env: {
            TOKEN: { value: 'secret-token' },
            FROM_HOST: { from_env: 'MEND_WORKSPACE_TEST_SECRET' },
            FLAG: true,
          },
          mounts: [{ source: '/tmp/cache', target: '/cache', read_only: true }],
          setup: ['echo setup'],
          checks: ['echo check'],
          ...overrides,
        },
      },
    },
  }) satisfies ProjectConfig

describe('DockerFixWorkspaceProvider', () => {
  afterEach(() => {
    delete process.env['MEND_WORKSPACE_TEST_SECRET']
  })

  test('starts a configured container without implicit host env or home mounts', async () => {
    process.env['MEND_WORKSPACE_TEST_SECRET'] = 'host-secret'
    const calls: RecordedCall[] = []
    const provider = new DockerFixWorkspaceProvider({
      runProcess: async (command, args, options) => {
        calls.push({ command, args, options })
        return { exitCode: 0, stdout: args[0] === 'run' ? 'container-id' : '', stderr: '' }
      },
    })

    await provider.prepare({
      project: makeProject(),
      mrIid: 42,
      worktreePath: '/tmp/worktree',
      attemptId: 'attempt-1',
    })

    const run = calls[0]
    expect(run?.command).toBe('docker')
    expect(run?.args).toContain('run')
    expect(run?.args).toContain('--network')
    expect(run?.args).toContain('none')
    expect(run?.args).toContain('--env')
    expect(run?.args).toContain('TOKEN')
    expect(run?.args).toContain('FROM_HOST')
    expect(run?.args).toContain('FLAG')
    expect(run?.options?.env).toMatchObject({
      TOKEN: 'secret-token',
      FROM_HOST: 'host-secret',
      FLAG: 'true',
    })
    expect(run?.args).not.toContain('TOKEN=secret-token')
    expect(run?.args).not.toContain('FROM_HOST=host-secret')
    expect(run?.args).not.toContain('FLAG=true')
    expect(run?.args.join('\n')).toContain('source=/tmp/worktree,target=/workspace')
    expect(run?.args.join('\n')).toContain('source=/tmp/cache,target=/cache,readonly')
    expect(run?.args.join('\n')).not.toContain('HOME=')
    expect(process.env['TOKEN']).toBeUndefined()
    expect(process.env['FROM_HOST']).toBeUndefined()
    expect(process.env['FLAG']).toBeUndefined()
  })

  test('mounts git worktree metadata at host paths so git works inside Docker', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'mend-docker-git-worktree-'))
    const worktreePath = join(tempDir, 'worktree')
    const gitdir = join(tempDir, 'repo.git', 'worktrees', 'feature')
    const commonDir = join(tempDir, 'repo.git')
    mkdirSync(worktreePath, { recursive: true })
    mkdirSync(gitdir, { recursive: true })
    mkdirSync(commonDir, { recursive: true })
    writeFileSync(join(worktreePath, '.git'), `gitdir: ${gitdir}\n`)
    writeFileSync(join(gitdir, 'commondir'), '../..\n')

    try {
      const calls: RecordedCall[] = []
      const provider = new DockerFixWorkspaceProvider({
        runProcess: async (command, args, options) => {
          calls.push({ command, args, options })
          return { exitCode: 0, stdout: args[0] === 'run' ? 'container-id' : '', stderr: '' }
        },
      })

      await provider.prepare({
        project: makeProject({ mounts: [], env: {} }),
        mrIid: 42,
        worktreePath,
        attemptId: 'attempt-1',
      })

      const runArgs = calls[0]?.args.join('\n') ?? ''
      expect(runArgs).toContain(`source=${worktreePath},target=/workspace`)
      expect(runArgs).toContain(`source=${gitdir},target=${gitdir}`)
      expect(runArgs).toContain(`source=${commonDir},target=${commonDir}`)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('runs setup before agent commands and masks configured env values', async () => {
    process.env['MEND_WORKSPACE_TEST_SECRET'] = 'host-secret'
    const execCommands: string[] = []
    const provider = new DockerFixWorkspaceProvider({
      runProcess: async (_command, args) => {
        if (args[0] === 'exec') {
          execCommands.push(args.at(-1) ?? '')
          return {
            exitCode: 0,
            stdout: `output secret-token host-secret ${args.at(-1)}`,
            stderr: '',
          }
        }
        return { exitCode: 0, stdout: 'container-id', stderr: '' }
      },
    })

    const workspace = await provider.prepare({
      project: makeProject(),
      mrIid: 42,
      worktreePath: '/tmp/worktree',
      attemptId: 'attempt-1',
    })
    const agentResult = await workspace.runAgentCommand('echo agent')

    expect(execCommands).toEqual(['echo setup', 'echo agent'])
    expect(workspace.setupResults[0]?.stdout).toBe('output [masked] [masked] echo setup')
    expect(agentResult.phase).toBe('agent')
    expect(agentResult.stdout).toBe('output [masked] [masked] echo agent')
    expect(workspace.git).toEqual({ mode: 'host', cwd: '/tmp/worktree' })
  })

  test('runs configured checks and tears down the container', async () => {
    process.env['MEND_WORKSPACE_TEST_SECRET'] = 'host-secret'
    const calls: RecordedCall[] = []
    const provider = new DockerFixWorkspaceProvider({
      runProcess: async (command, args) => {
        calls.push({ command, args })
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    })

    const workspace = await provider.prepare({
      project: makeProject(),
      mrIid: 42,
      worktreePath: '/tmp/worktree',
      attemptId: 'attempt-1',
    })
    const checks = await workspace.runChecks()
    await workspace.teardown()

    expect(checks).toHaveLength(1)
    expect(checks[0]?.phase).toBe('check')
    expect(
      calls.some((call) => call.args.join(' ') === 'rm --force mend-demo-mr-42-attempt-1'),
    ).toBe(true)
  })

  test('tears down and fails when deterministic setup fails', async () => {
    process.env['MEND_WORKSPACE_TEST_SECRET'] = 'host-secret'
    const calls: RecordedCall[] = []
    const provider = new DockerFixWorkspaceProvider({
      runProcess: async (command, args) => {
        calls.push({ command, args })
        if (args[0] === 'exec') {
          return { exitCode: 1, stdout: '', stderr: 'setup failed secret-token' }
        }
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    })

    await expect(
      provider.prepare({
        project: makeProject(),
        mrIid: 42,
        worktreePath: '/tmp/worktree',
        attemptId: 'attempt-1',
      }),
    ).rejects.toThrow('setup failed [masked]')
    expect(
      calls.some((call) => call.args.join(' ') === 'rm --force mend-demo-mr-42-attempt-1'),
    ).toBe(true)
  })

  test('masks env values in docker startup failures', async () => {
    process.env['MEND_WORKSPACE_TEST_SECRET'] = 'host-secret'
    const provider = new DockerFixWorkspaceProvider({
      runProcess: async () => ({
        exitCode: 1,
        stdout: '',
        stderr: 'failed with secret-token and host-secret',
      }),
    })

    await expect(
      provider.prepare({
        project: makeProject(),
        mrIid: 42,
        worktreePath: '/tmp/worktree',
        attemptId: 'attempt-1',
      }),
    ).rejects.toThrow('failed with [masked] and [masked]')
  })
})

const dockerSmoke = process.env.DOCKER_TESTS === '1' ? test : test.skip

dockerSmoke(
  'DockerFixWorkspaceProvider smoke runs setup, agent, checks, and teardown',
  async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'mend-docker-workspace-'))
    process.env['MEND_WORKSPACE_TEST_SECRET'] = 'smoke-secret'
    const provider = new DockerFixWorkspaceProvider()

    try {
      const workspace = await provider.prepare({
        project: makeProject({
          env: { SECRET: { from_env: 'MEND_WORKSPACE_TEST_SECRET' } },
          mounts: [],
          setup: ['echo "$SECRET" > setup.txt'],
          checks: ['test -f setup.txt'],
        }),
        mrIid: 1,
        worktreePath: tempDir,
        attemptId: `${Date.now()}`,
      })

      const agentResult = await workspace.runAgentCommand('cat setup.txt')
      const checkResults = await workspace.runChecks()
      await workspace.teardown()

      expect(agentResult.stdout.trim()).toBe('[masked]')
      expect(checkResults.every((result) => result.exitCode === 0)).toBe(true)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
      delete process.env.MEND_WORKSPACE_TEST_SECRET
    }
  },
)
