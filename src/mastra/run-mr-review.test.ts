import { describe, expect, it } from 'bun:test'
import type { MrReviewInput } from '@/lib/review-run-input'
import { applyReviewRunSourceOverrides, extractWorkflowFailure } from '@/mastra/run-mr-review'

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

describe('extractWorkflowFailure', () => {
  it('uses the failed post step diagnostic without letting a successful step mask it', () => {
    expect(
      extractWorkflowFailure({
        status: 'failed',
        steps: {
          review: { status: 'success', result: { message: 'review completed' } },
          post: {
            status: 'failed',
            result: { error: { message: 'git diff base...HEAD: invalid symmetric difference' } },
          },
        },
      }),
    ).toEqual({
      phase: 'post',
      category: 'git',
      message: 'git diff base...HEAD: invalid symmetric difference',
    })
  })
})
