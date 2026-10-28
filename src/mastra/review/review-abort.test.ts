import { describe, expect, it } from 'bun:test'
import { createStep, createWorkflow } from '@mastra/core/workflows'
import { z } from 'zod'
import { createReviewRequestContext, getReviewAbortSignal } from '@/mastra/review/review-abort'

const createSignalProbeWorkflow = (observed: Array<AbortSignal | undefined>) => {
  const probeStep = createStep({
    id: 'probe',
    inputSchema: z.object({}),
    outputSchema: z.object({}),
    execute: async ({ requestContext }) => {
      observed.push(getReviewAbortSignal(requestContext))
      return {}
    },
  })

  return createWorkflow({
    id: 'review-abort-probe',
    inputSchema: z.object({}),
    outputSchema: z.object({}),
  })
    .then(probeStep)
    .commit()
}

describe('review abort request context', () => {
  it('delivers the abort signal to workflow steps', async () => {
    const abortController = new AbortController()
    const observed: Array<AbortSignal | undefined> = []
    const run = await createSignalProbeWorkflow(observed).createRun()

    const result = await run.start({
      inputData: {},
      requestContext: createReviewRequestContext(abortController.signal),
    })

    expect(result.status).toBe('success')
    expect(observed).toEqual([abortController.signal])
  })

  it('reports no signal when none was provided', async () => {
    const observed: Array<AbortSignal | undefined> = []
    const run = await createSignalProbeWorkflow(observed).createRun()

    await run.start({ inputData: {}, requestContext: createReviewRequestContext() })

    expect(observed).toEqual([undefined])
  })
})
