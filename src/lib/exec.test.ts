import { describe, expect, test } from 'bun:test'
import { assertCommitSha, sanitizeGitEnv } from '@/lib/exec'

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
