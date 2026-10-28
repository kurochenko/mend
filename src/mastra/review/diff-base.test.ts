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
          baseSha: initialSha,
          startSha: initialSha,
          headSha,
        },
        refetchOrigin: async () => {},
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
          baseSha: initialSha,
          startSha: initialSha,
          headSha,
        },
        refetchOrigin: async () => {},
      })

      expect(result.baseRef).toBe(initialSha)
      expect(result.warnings.some((warning) => warning.includes('not an ancestor'))).toBe(true)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('prefers the origin tracking ref over a stale local target branch', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'mend-diff-base-'))

    try {
      const defaultBranch = await initRepo(cwd)
      await commitFile(cwd, 'file.txt', 'one\n', 'initial')
      const trackedSha = await commitFile(cwd, 'file.txt', 'two\n', 'advanced target')
      await execGit(['update-ref', `refs/remotes/origin/${defaultBranch}`, trackedSha], cwd)
      await execGit(['reset', '--hard', 'HEAD~1'], cwd)
      const headSha = await execGit(['rev-parse', 'HEAD'], cwd)

      const result = await resolveDiffBaseRef({
        worktreePath: cwd,
        reviewMode: 'initial',
        previousReviewedSha: null,
        targetBranch: defaultBranch,
        diffRefs: { baseSha: 'a'.repeat(40), headSha },
        refetchOrigin: async () => {},
      })

      expect(result.baseRef).toBe(`refs/remotes/origin/${defaultBranch}`)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('refetches origin and retries when no candidate exists locally', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'mend-diff-base-'))

    try {
      await initRepo(cwd)
      const headSha = await commitFile(cwd, 'file.txt', 'one\n', 'initial')
      let refetchCount = 0

      const result = await resolveDiffBaseRef({
        worktreePath: cwd,
        reviewMode: 'initial',
        previousReviewedSha: null,
        targetBranch: 'release',
        diffRefs: { baseSha: 'b'.repeat(40), headSha },
        refetchOrigin: async () => {
          refetchCount++
          await execGit(['update-ref', 'refs/remotes/origin/release', headSha], cwd)
        },
      })

      expect(refetchCount).toBe(1)
      expect(result.baseRef).toBe('refs/remotes/origin/release')
      expect(result.warnings.some((warning) => warning.includes('fetching origin'))).toBe(true)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
