import { RequestContext } from '@mastra/core/request-context'

const reviewAbortSignalKey = 'mendReviewAbortSignal'

export const createReviewRequestContext = (signal?: AbortSignal): RequestContext => {
  const requestContext = new RequestContext()
  if (signal) {
    requestContext.set(reviewAbortSignalKey, signal)
  }
  return requestContext
}

export const getReviewAbortSignal = (requestContext: RequestContext): AbortSignal | undefined => {
  const signal: unknown = requestContext.get(reviewAbortSignalKey)
  return signal instanceof AbortSignal ? signal : undefined
}
