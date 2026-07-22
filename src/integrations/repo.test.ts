import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import type { ProjectConfig } from '@/config'
import {
  commitAndPushWorktree,
  shouldFetchRequestedCommitAfterBranchFetch,
} from '@/integrations/repo'
import { sanitizeGitEnv } from '@/lib/exec'

const makeProject = (originPath: string): ProjectConfig => ({
  key: 'repo-test',
  platform: 'gitlab',
  url: 'https://gitlab.example.com',
  token: 'token',
  webhook_secret: 'secret',
  project_id: 1,
  repo_url: originPath,
  default_branch: 'main',
  trigger: { mode: 'ready' },
  clone_path: join(originPath, '..', 'bare.git'),
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
    comparison: { enabled: false, harness: 'opencode', timeout_ms: 300_000 },
    memory: { project_scope_usernames: [] },
    triage: { trusted_usernames: [] },
    fix: { enabled: false, automatic: false, max_loops: 3 },
  },
})

const gitPath = process.env.PATH?.trim()
  ? process.env.PATH
  : '/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin'

const gitEnv = (): Record<string, string> => ({
  ...sanitizeGitEnv(process.env),
  PATH: gitPath,
})

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnv() }).trim()

const gitCommit = (cwd: string, message: string): string =>
  git(cwd, [
    '-c',
    'user.name=Tester',
    '-c',
    'user.email=tester@example.invalid',
    'commit',
    '-m',
    message,
  ])

const restoreEnvVar = (key: string, value: string | undefined): void => {
  if (value === undefined) {
    delete process.env[key]
    return
  }

  process.env[key] = value
}

describe('commitAndPushWorktree', () => {
  let tmp: string | null = null

  afterEach(() => {
    if (tmp) {
      rmSync(tmp, { recursive: true, force: true })
      tmp = null
    }
  })

  const setupWorktree = (): { origin: string; worktree: string } => {
    tmp = mkdtempSync(join(tmpdir(), 'mend-repo-test-'))
    const origin = join(tmp, 'origin.git')
    const worktree = join(tmp, 'worktree')

    git(tmp, ['init', '--initial-branch=main', '--bare', origin])
    git(tmp, ['clone', origin, worktree])
    git(worktree, ['checkout', '-b', 'feature/fix'])
    writeFileSync(join(worktree, 'README.md'), 'initial\n')
    git(worktree, ['add', 'README.md'])
    gitCommit(worktree, 'initial')
    git(worktree, ['push', 'origin', 'feature/fix'])

    return { origin, worktree }
  }

  test('commits local changes and verifies the remote source branch head', async () => {
    const { origin, worktree } = setupWorktree()
    writeFileSync(join(worktree, 'README.md'), 'initial\nfixed\n')

    const result = await commitAndPushWorktree({
      project: makeProject(origin),
      worktreePath: worktree,
      sourceBranch: 'feature/fix',
      commitMessage: 'fix: address test finding',
    })

    expect(result.pushedBranch).toBe('feature/fix')
    expect(result.remoteHeadSha).toBe(result.commitSha)
    expect(git(origin, ['rev-parse', 'refs/heads/feature/fix'])).toBe(result.commitSha)
    expect(git(worktree, ['log', '--format=%an <%ae>', '-1'])).toBe('Mend <mend@example.invalid>')
  })

  test('uses the Mend commit identity when git identity environment variables are present', async () => {
    const originalAuthorName = process.env.GIT_AUTHOR_NAME
    const originalAuthorEmail = process.env.GIT_AUTHOR_EMAIL
    const originalCommitterName = process.env.GIT_COMMITTER_NAME
    const originalCommitterEmail = process.env.GIT_COMMITTER_EMAIL
    const { origin, worktree } = setupWorktree()
    writeFileSync(join(worktree, 'README.md'), 'initial\nfixed\n')

    try {
      process.env.GIT_AUTHOR_NAME = 'Evil Author'
      process.env.GIT_AUTHOR_EMAIL = 'evil-author@example.invalid'
      process.env.GIT_COMMITTER_NAME = 'Evil Committer'
      process.env.GIT_COMMITTER_EMAIL = 'evil-committer@example.invalid'

      const result = await commitAndPushWorktree({
        project: makeProject(origin),
        worktreePath: worktree,
        sourceBranch: 'feature/fix',
        commitMessage: 'fix: address test finding',
      })

      expect(git(worktree, ['log', '--format=%an <%ae>|%cn <%ce>', '-1'])).toBe(
        'Mend <mend@example.invalid>|Mend <mend@example.invalid>',
      )
      expect(result.remoteHeadSha).toBe(result.commitSha)
    } finally {
      restoreEnvVar('GIT_AUTHOR_NAME', originalAuthorName)
      restoreEnvVar('GIT_AUTHOR_EMAIL', originalAuthorEmail)
      restoreEnvVar('GIT_COMMITTER_NAME', originalCommitterName)
      restoreEnvVar('GIT_COMMITTER_EMAIL', originalCommitterEmail)
    }
  })

  test('refuses refspec-shaped push destinations before mutating the worktree', async () => {
    const { origin, worktree } = setupWorktree()
    writeFileSync(join(worktree, 'README.md'), 'initial\nfixed\n')

    await expect(
      commitAndPushWorktree({
        project: makeProject(origin),
        worktreePath: worktree,
        sourceBranch: 'feature/fix:main',
        commitMessage: 'fix: address test finding',
      }),
    ).rejects.toThrow('Invalid source branch push destination')

    expect(git(worktree, ['status', '--porcelain'])).toBe('M README.md')
  })
})

describe('shouldFetchRequestedCommitAfterBranchFetch', () => {
  test('requests explicit SHA fetch only when a requested commit is still missing', () => {
    expect(shouldFetchRequestedCommitAfterBranchFetch(undefined, false)).toBe(false)
    expect(shouldFetchRequestedCommitAfterBranchFetch('a'.repeat(40), true)).toBe(false)
    expect(shouldFetchRequestedCommitAfterBranchFetch('a'.repeat(40), false)).toBe(true)
  })
})
