import { describe, expect, test } from 'bun:test'
import { shouldFetchRequestedCommitAfterBranchFetch } from '@/integrations/repo'

describe('shouldFetchRequestedCommitAfterBranchFetch', () => {
  test('requests explicit SHA fetch only when a requested commit is still missing', () => {
    expect(shouldFetchRequestedCommitAfterBranchFetch(undefined, false)).toBe(false)
    expect(shouldFetchRequestedCommitAfterBranchFetch('a'.repeat(40), true)).toBe(false)
    expect(shouldFetchRequestedCommitAfterBranchFetch('a'.repeat(40), false)).toBe(true)
  })
})
