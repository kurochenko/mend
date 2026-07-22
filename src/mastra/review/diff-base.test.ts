import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { execGit } from '@/lib/exec'
import { resolveDiffBaseRef } from '@/mastra/review/diff-base'

const initRepo = async (cwd: string): Promise<string> => {
  await execGit(['init'], cwd)
  return await execGit(['branch', '--show-current'], cwd)
}

const testCommitIdentity = {
  'user.name': 'Mend Test',
  'user.email': 'mend-test@example.com',
}

const commitFile = async (
  cwd: string,
  fileName: string,
  content: string,
  message: string,
): Promise<string> => {
  writeFileSync(join(cwd, fileName), content)
  await execGit(['add', fileName], cwd)
  await execGit(['commit', '-m', message], cwd, { config: testCommitIdentity })
  return await execGit(['rev-parse', 'HEAD'], cwd)
}

describe('resolveDiffBaseRef', () => {
  it('prefers previous reviewed SHA when it is an ancestor of head', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'mend-diff-base-'))

    try {
      const defaultBranch = await initRepo(cwd)
      const initialSha = await commitFile(cwd, 'file.txt', 'one\n', 'initial')
      const previousSha = await commitFile(cwd, 'file.txt', 'two\n', 'previous reviewed')
      const headSha = await commitFile(cwd, 'file.txt', 'three\n', 'current')

      const result = await resolveDiffBaseRef({
        worktreePath: cwd,
        reviewMode: 'update',
        previousReviewedSha: previousSha,
        targetBranch: defaultBranch,
        diffRefs: {
          base_sha: initialSha,
          start_sha: initialSha,
          head_sha: headSha,
        },
      })

      expect(result.baseRef).toBe(previousSha)
      expect(result.warnings.some((warning) => warning.includes('not an ancestor'))).toBe(false)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('falls back to MR diff refs when previous reviewed SHA is not an ancestor', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'mend-diff-base-'))

    try {
      const defaultBranch = await initRepo(cwd)
      const initialSha = await commitFile(cwd, 'file.txt', 'one\n', 'initial')

      await execGit(['checkout', '-b', 'old-review'], cwd)
      const previousSha = await commitFile(cwd, 'file.txt', 'old-review\n', 'old review')

      await execGit(['checkout', defaultBranch], cwd)
      const headSha = await commitFile(cwd, 'file.txt', 'current\n', 'current')

      const result = await resolveDiffBaseRef({
        worktreePath: cwd,
        reviewMode: 'update',
        previousReviewedSha: previousSha,
        targetBranch: defaultBranch,
        diffRefs: {
          base_sha: initialSha,
          start_sha: initialSha,
          head_sha: headSha,
        },
      })

      expect(result.baseRef).toBe(initialSha)
      expect(result.warnings.some((warning) => warning.includes('not an ancestor'))).toBe(true)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
