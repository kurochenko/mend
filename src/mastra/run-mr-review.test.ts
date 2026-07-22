import { describe, expect, it } from 'bun:test'
import { applyReviewRunSourceOverrides } from '@/mastra/run-mr-review'
import type { MrReviewInput } from '@/lib/review-run-input'

const input: MrReviewInput = {
  projectKey: 'app',
  mrIid: 1,
  title: 'MR',
  description: '',
  labels: [],
  sourceBranch: 'feature',
  targetBranch: 'main',
  url: 'https://gitlab.example.com/group/project/-/merge_requests/1',
  reviewMode: 'initial',
  previousReviewedSha: null,
  previousRunId: null,
}

describe('applyReviewRunSourceOverrides', () => {
  it('forces dry run for benchmark replay source only', () => {
    expect(applyReviewRunSourceOverrides(input, 'replay_benchmark').forceDryRun).toBe(true)
    expect(applyReviewRunSourceOverrides(input, 'replay_iid').forceDryRun).toBeUndefined()
    expect(applyReviewRunSourceOverrides(input, 'webhook').forceDryRun).toBeUndefined()
  })
})
