import { createWorkflow } from '@mastra/core/workflows'
import { mrReviewInputSchema } from '@/lib/review-run-input'
import { postStepOutputSchema } from '@/mastra/review/run-result'
import { setupStep } from '@/mastra/steps/setup'
import { reviewStep } from '@/mastra/steps/review'
import { postStep } from '@/mastra/steps/post'

export const mrReviewWorkflow = createWorkflow({
  id: 'mr-review',
  inputSchema: mrReviewInputSchema,
  outputSchema: postStepOutputSchema,
})
  .then(setupStep)
  .then(reviewStep)
  .then(postStep)
  .commit()
