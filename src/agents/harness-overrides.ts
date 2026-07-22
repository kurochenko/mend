import type { ReviewAgentHarness, ReviewAgentHarnessId } from '@/agents/review-harness'

let reviewHarnessOverrides: Partial<Record<ReviewAgentHarnessId, ReviewAgentHarness>> | undefined

export const setReviewHarnessOverridesForTesting = (
  harnesses: Partial<Record<ReviewAgentHarnessId, ReviewAgentHarness>> | undefined,
): void => {
  reviewHarnessOverrides = harnesses
}

export const getReviewHarnessOverridesForTesting = ():
  | Partial<Record<ReviewAgentHarnessId, ReviewAgentHarness>>
  | undefined => reviewHarnessOverrides
