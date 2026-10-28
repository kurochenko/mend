import { describe, expect, test } from 'bun:test'
import { assertCommitSha, buildGitConfigEnv, execGit, sanitizeGitEnv } from '@/lib/exec'

describe('sanitizeGitEnv', () => {
  test('strips git identity and repository environment variables', () => {
    const env = sanitizeGitEnv({
      PATH: '/usr/bin',
      HOME: '/tmp/home',
      GIT_AUTHOR_NAME: 'Evil Author',
      GIT_AUTHOR_EMAIL: 'evil-author@example.invalid',
      GIT_COMMITTER_NAME: 'Evil Committer',
      GIT_COMMITTER_EMAIL: 'evil-committer@example.invalid',
      GIT_DIR: '/tmp/wrong.git',
      GIT_WORK_TREE: '/tmp/wrong-worktree',
      GIT_INDEX_FILE: '/tmp/wrong-index',
    })

    expect(env).toEqual({
      PATH: '/usr/bin',
      HOME: '/tmp/home',
    })
  })
})

describe('assertCommitSha', () => {
  test('accepts full 40-character commit SHAs only', () => {
    const sha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

    expect(assertCommitSha(sha)).toBe(sha)
    expect(() => assertCommitSha('aaaaaaa')).toThrow('Invalid commit SHA')
    expect(() => assertCommitSha('g'.repeat(40))).toThrow('Invalid commit SHA')
  })
})

describe('execGit', () => {
  test('applies per-call config through the environment and keeps it out of error messages', async () => {
    const secret = 'Authorization: Basic c2VjcmV0LXRva2Vu'

    expect(
      await execGit(['config', '--get', 'http.extraHeader'], process.cwd(), {
        config: { 'http.extraHeader': secret },
      }),
    ).toBe(secret)

    const failure = await execGit(
      ['rev-parse', '--verify', 'refs/heads/mend-missing-ref'],
      process.cwd(),
      {
        config: { 'http.extraHeader': secret },
      },
    ).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toContain(
      'git rev-parse --verify refs/heads/mend-missing-ref',
    )
    expect((failure as Error).message).not.toContain('c2VjcmV0LXRva2Vu')
  })

  test('builds no environment for an empty config', () => {
    expect(buildGitConfigEnv({})).toEqual({})
  })
})
