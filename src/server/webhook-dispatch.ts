import type { Mastra } from '@mastra/core'
import type { ProjectConfig } from '@/config'
import { enqueueMrReview } from '@/server/mr-review-queue'
import { processReviewNoteEvent } from '@/server/review-note-events'
import type { ReviewWebhookEvent } from '@/server/webhook-events'

export const dispatchReviewWebhookEvent = (params: {
  mastra: Mastra
  project: ProjectConfig
  event: ReviewWebhookEvent
  rawPayload: unknown
}): void => {
  const { mastra, project, event, rawPayload } = params

  if (event.type === 'mr_review_requested') {
    const { headSha, ...reviewEvent } = event
    console.log(`[webhook] review requested: ${event.url} (${event.projectKey})`)
    enqueueMrReview({
      mastra,
      project,
      payload: rawPayload,
      event: reviewEvent,
      commitSha: headSha,
    }).catch((err: unknown) =>
      console.error(`[webhook] queue failure for ${event.projectKey} MR !${event.mrIid}:`, err),
    )
    return
  }

  if (event.type === 'mr_note_received') {
    const { mrIid, noteId } = event.note
    console.log(`[webhook] note received for ${event.projectKey} MR !${mrIid} note ${noteId}`)
    processReviewNoteEvent({ project, note: event.note, rawPayload }).catch((err: unknown) =>
      console.error(
        `[webhook] note processing failure for ${event.projectKey} MR !${mrIid} note ${noteId}:`,
        err,
      ),
    )
  }
}
