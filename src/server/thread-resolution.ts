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

    if (resolution.markResolved) {
      try {
        await params.provider.resolveThread(params.mrIid, resolution.discussionId)
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
        markResolved: resolution.markResolved,
      })
    } catch (err) {
      console.warn(
        `[post] failed to persist local thread state for ${resolution.discussionId}: ${toErrorMessage(err)}`,
      )
    }

    if (resolution.markResolved) {
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
