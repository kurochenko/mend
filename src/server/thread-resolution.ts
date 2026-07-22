import type { GitLabClient } from '@/integrations/gitlab/client'
import type { PlannedThreadResolution } from '@/mastra/review/publish-plan'
import { persistGitLabReplyLocally } from '@/server/thread-sync'
import type { DiscussionNote } from '@/integrations/gitlab/discussions'
import { toErrorMessage } from '@/lib/errors'

export interface ResolutionStats {
  resolvedThreadCount: number
  partiallyFixedThreadCount: number
  unmatchedVerdictCount: number
}

interface ThreadResolutionDependencies {
  persistReply: typeof persistGitLabReplyLocally
}

const defaultDependencies: ThreadResolutionDependencies = {
  persistReply: persistGitLabReplyLocally,
}

export const executeThreadResolutions = async (params: {
  gitlab: GitLabClient
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
    let reply: DiscussionNote

    try {
      reply = await params.gitlab.replyToDiscussion(
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
        await params.gitlab.resolveDiscussion(params.mrIid, resolution.discussionId)
      } catch (err) {
        console.warn(
          `[post] failed to resolve thread ${resolution.discussionId} after replying: ${err}`,
        )
        continue
      }
    }

    try {
      await dependencies.persistReply({
        discussionId: resolution.discussionId,
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
