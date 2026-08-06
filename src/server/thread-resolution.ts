import type { ReviewProvider } from '@/integrations/provider/client'
import type { ProviderThreadMessage } from '@/integrations/provider/types'
import type { PlannedThreadResolution } from '@/mastra/review/publish-plan'
import { persistProviderReplyLocally } from '@/server/thread-sync'
import { toErrorMessage } from '@/lib/errors'

export interface ResolutionStats {
  resolvedThreadCount: number
  partiallyFixedThreadCount: number
  unmatchedVerdictCount: number
}

interface ThreadResolutionDependencies {
  persistReply: typeof persistProviderReplyLocally
}

const defaultDependencies: ThreadResolutionDependencies = {
  persistReply: persistProviderReplyLocally,
}

const shouldPersistUnresolvableFindingResolution = (params: {
  provider: ReviewProvider
  threadId: string
  markResolved: boolean
}): boolean =>
  params.markResolved && params.provider.kind === 'github' && params.threadId.startsWith('note_')

export const executeThreadResolutions = async (params: {
  provider: ReviewProvider
  mrIid: number
  reviewRunId: string
  resolutions: PlannedThreadResolution[]
  unmatchedVerdictCount: number
  dependencies?: Partial<ThreadResolutionDependencies>
}): Promise<ResolutionStats> => {
  const dependencies = { ...defaultDependencies, ...params.dependencies }
  let resolvedThreadCount = 0
  let partiallyFixedThreadCount = 0

  for (const resolution of params.resolutions) {
    let reply: ProviderThreadMessage

    try {
      reply = await params.provider.replyToThread(
        params.mrIid,
        resolution.discussionId,
        resolution.replyBody,
      )
    } catch (err) {
      console.warn(`[post] failed to reply to thread ${resolution.discussionId}: ${err}`)
      continue
    }

    let providerResolved = false
    if (resolution.markResolved) {
      try {
        providerResolved = await params.provider.resolveThread(
          params.mrIid,
          resolution.discussionId,
        )
      } catch (err) {
        console.warn(
          `[post] failed to resolve thread ${resolution.discussionId} after replying: ${err}`,
        )
        continue
      }
    }

    try {
      await dependencies.persistReply({
        provider: params.provider.kind,
        threadId: resolution.discussionId,
        reviewRunId: params.reviewRunId,
        reply,
        markResolved: providerResolved,
        markFindingResolved:
          providerResolved ||
          shouldPersistUnresolvableFindingResolution({
            provider: params.provider,
            threadId: resolution.discussionId,
            markResolved: resolution.markResolved,
          }),
      })
    } catch (err) {
      console.warn(
        `[post] failed to persist local thread state for ${resolution.discussionId}: ${toErrorMessage(err)}`,
      )
    }

    if (providerResolved) {
      console.log(
        `[post] resolved thread ${resolution.discussionId} for ${resolution.previousFindingId}`,
      )
      resolvedThreadCount++
      continue
    }

    console.log(
      `[post] replied to thread ${resolution.discussionId} for partially fixed ${resolution.previousFindingId}`,
    )
    partiallyFixedThreadCount++
  }

  return {
    resolvedThreadCount,
    partiallyFixedThreadCount,
    unmatchedVerdictCount: params.unmatchedVerdictCount,
  }
}
