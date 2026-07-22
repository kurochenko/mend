import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sanitizeGitEnv } from '@/lib/exec'

export interface TestGitOrigin {
  root: string
  originPath: string
  worktreePath: string
  sourceBranch: string
  targetBranch: string
  baseSha: string
  headSha: string
  startSha: string
  changedFiles: string[]
  cleanup: () => void
}

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: sanitizeGitEnv(process.env) }).trim()

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

export const createTestGitOrigin = (): TestGitOrigin => {
  const root = mkdtempSync(join(tmpdir(), 'mend-e2e-git-'))
  const originPath = join(root, 'origin.git')
  const worktreePath = join(root, 'worktree')
  const sourceBranch = 'feature/review-flow'
  const targetBranch = 'main'

  git(root, ['init', '--initial-branch=main', '--bare', originPath])
  git(root, ['clone', originPath, worktreePath])

  mkdirSync(join(worktreePath, 'src'), { recursive: true })
  writeFileSync(
    join(worktreePath, 'src/app.ts'),
    [
      'export const greeting = (name: string): string => {',
      '  const normalized = name.trim()',
      '  return `Hello, ${normalized}`',
      '}',
      '',
    ].join('\n'),
  )
  writeFileSync(join(worktreePath, 'README.md'), 'Review flow fixture\n')
  git(worktreePath, ['add', '.'])
  gitCommit(worktreePath, 'initial')
  git(worktreePath, ['push', 'origin', targetBranch])
  const baseSha = git(worktreePath, ['rev-parse', 'HEAD'])

  git(worktreePath, ['checkout', '-b', sourceBranch])
  writeFileSync(
    join(worktreePath, 'src/app.ts'),
    [
      'export const greeting = (name: string): string => {',
      '  const normalized = name.trim().toUpperCase()',
      '  return `Hello, ${normalized}!`',
      '}',
      '',
      "export const farewell = (): string => 'bye'",
      '',
    ].join('\n'),
  )
  writeFileSync(
    join(worktreePath, 'src/new-feature.ts'),
    [
      'export const featureEnabled = true',
      '',
      'export const featureName = (): string => {',
      "  return 'review-flow'",
      '}',
      '',
    ].join('\n'),
  )
  git(worktreePath, ['add', '.'])
  gitCommit(worktreePath, 'feature change')
  git(worktreePath, ['push', 'origin', sourceBranch])
  const headSha = git(worktreePath, ['rev-parse', 'HEAD'])

  return {
    root,
    originPath,
    worktreePath,
    sourceBranch,
    targetBranch,
    baseSha,
    headSha,
    startSha: baseSha,
    changedFiles: ['src/app.ts', 'src/new-feature.ts'],
    cleanup: () => {
      rmSync(root, { recursive: true, force: true })
    },
  }
}
