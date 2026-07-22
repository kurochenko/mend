import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'
import {
  collectChangedSymbolCallers,
  collectTestsTouchingChangedCode,
  type ReviewContextDiagnostic,
} from '@/mastra/review/context-package'
import { sanitizeGitEnv } from '@/lib/exec'

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: sanitizeGitEnv(process.env) }).trim()

const gitCommit = (cwd: string, message: string): void => {
  git(cwd, [
    '-c',
    'user.name=Tester',
    '-c',
    'user.email=tester@example.invalid',
    'commit',
    '-m',
    message,
  ])
}

describe('review context retrieval slices', () => {
  let tmp: string | null = null

  afterEach(() => {
    if (tmp) {
      rmSync(tmp, { recursive: true, force: true })
      tmp = null
    }
  })

  it('collects external callers for changed exported symbols', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'mend-context-package-callers-'))
    const repo = join(tmp, 'repo')
    mkdirSync(join(repo, 'src'), { recursive: true })
    git(tmp, ['init', '--initial-branch=main', repo])
    writeFileSync(join(repo, 'package.json'), '{"type":"module"}\n')
    writeFileSync(join(repo, 'src/changed.ts'), 'export function runReview() {}\n')
    writeFileSync(
      join(repo, 'src/caller.ts'),
      "import { runReview } from './changed'\nrunReview()\n",
    )
    git(repo, ['add', '.'])
    gitCommit(repo, 'base')

    const diagnostics: ReviewContextDiagnostic[] = []
    const callers = await collectChangedSymbolCallers({
      worktreePath: repo,
      changedFiles: ['src/changed.ts'],
      diagnostics,
    })

    expect(callers).toEqual([
      {
        file: 'src/changed.ts',
        symbol: 'runReview',
        sites: [{ file: 'src/caller.ts', line: 1 }],
        hiddenSiteCount: 0,
      },
    ])
    expect(diagnostics).toEqual([])
  })

  it('collects tests touching changed files and files without test references', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'mend-context-package-tests-'))
    const repo = join(tmp, 'repo')
    mkdirSync(join(repo, 'src/__tests__'), { recursive: true })
    git(tmp, ['init', '--initial-branch=main', repo])
    writeFileSync(join(repo, 'package.json'), '{"type":"module"}\n')
    writeFileSync(join(repo, 'src/changed.ts'), 'export const parseReview = () => null\n')
    writeFileSync(join(repo, 'src/untested.ts'), 'export const untested = true\n')
    writeFileSync(
      join(repo, 'src/__tests__/changed.test.ts'),
      "import { parseReview } from '../changed'\nparseReview()\n",
    )
    git(repo, ['add', '.'])
    gitCommit(repo, 'base')

    const tests = await collectTestsTouchingChangedCode({
      worktreePath: repo,
      changedFiles: ['src/changed.ts', 'src/untested.ts'],
      symbols: [],
    })

    expect(tests).toEqual({
      testReferences: [
        {
          testFile: 'src/__tests__/changed.test.ts',
          references: ['parseReview', 'src/changed.ts'],
        },
      ],
      changedFilesWithoutTestReferences: ['src/untested.ts'],
    })
  })
})
