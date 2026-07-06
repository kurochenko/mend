import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Hono } from 'hono'
import { z } from 'zod'
import type { Mastra } from '@mastra/core'
import type { AppConfig, GitLabProjectConfig } from '@/config'
import { enqueueMrReview } from '@/server/mr-review-queue'
import { processReviewNoteEvent } from '@/server/review-note-events'
import type { ReviewWebhookEvent } from '@/server/webhook-events'

const FIXTURES_DIR = resolve('fixtures', 'webhooks')
const RECORDING_CONCURRENCY = 2
const MAX_PENDING_RECORDINGS = 200

interface QueuedRecording {
  projectKey: string
  payload: WebhookPayload
}

const recordingQueue: QueuedRecording[] = []
let recordingWorkers = 0

const gitlabProjectSchema = z
  .object({
    id: z.number(),
    name: z.string(),
    web_url: z.string(),
  })
  .passthrough()

const mrObjectAttributesSchema = z
  .object({
    iid: z.number(),
    title: z.string(),
    description: z.string().nullable().optional(),
    labels: z.array(z.object({ title: z.string() }).passthrough()).optional(),
    source_branch: z.string(),
    target_branch: z.string(),
    state: z.string(),
    action: z.string(),
    draft: z.boolean(),
    url: z.string(),
  })
  .passthrough()

const mrChangesSchema = z
  .object({
    draft: z.object({ previous: z.boolean(), current: z.boolean() }).optional(),
  })
  .passthrough()

const mrWebhookPayloadSchema = z
  .object({
    object_kind: z.literal('merge_request'),
    project: gitlabProjectSchema,
    object_attributes: mrObjectAttributesSchema,
    labels: z.array(z.object({ title: z.string() }).passthrough()).optional(),
    changes: mrChangesSchema.optional(),
  })
  .passthrough()

const noteObjectAttributesSchema = z
  .object({
    id: z.number(),
    note: z.string(),
    noteable_type: z.string(),
    discussion_id: z.string().optional(),
    type: z.string().nullable(),
    action: z.string().optional(),
    author_id: z.number().optional(),
    created_at: z.string().optional(),
    updated_at: z.string().optional(),
    url: z.string().optional(),
    system: z.boolean().optional(),
  })
  .passthrough()

const noteWebhookPayloadSchema = z
  .object({
    object_kind: z.literal('note'),
    project: gitlabProjectSchema,
    user: z
      .object({
        id: z.number(),
        username: z.string(),
      })
      .passthrough(),
    merge_request: z.object({ iid: z.number() }).passthrough().optional(),
    object_attributes: noteObjectAttributesSchema,
  })
  .passthrough()

const webhookPayloadSchema = z.discriminatedUnion('object_kind', [
  mrWebhookPayloadSchema,
  noteWebhookPayloadSchema,
])

export type MrWebhookPayload = z.infer<typeof mrWebhookPayloadSchema>
export type NoteWebhookPayload = z.infer<typeof noteWebhookPayloadSchema>
export type WebhookPayload = z.infer<typeof webhookPayloadSchema>

const writeRecordedPayload = async (projectKey: string, payload: WebhookPayload): Promise<void> => {
  await mkdir(FIXTURES_DIR, { recursive: true })
  const objectKind = payload.object_kind
  const timestamp = Date.now()
  const filename = `${projectKey}-${objectKind}-${timestamp}-${crypto.randomUUID()}.json`
  await writeFile(resolve(FIXTURES_DIR, filename), JSON.stringify(payload, null, 2))
  console.log(`[webhook] recorded payload to fixtures/webhooks/${filename}`)
}

const drainRecordingQueue = (): void => {
  while (recordingWorkers < RECORDING_CONCURRENCY && recordingQueue.length > 0) {
    const next = recordingQueue.shift()
    if (!next) {
      return
    }

    recordingWorkers++
    void writeRecordedPayload(next.projectKey, next.payload)
      .catch((error) => {
        console.error(`[webhook] failed to record payload for ${next.projectKey}:`, error)
      })
      .finally(() => {
        recordingWorkers--
        drainRecordingQueue()
      })
  }
}

const recordPayload = (projectKey: string, payload: WebhookPayload): void => {
  if (recordingQueue.length >= MAX_PENDING_RECORDINGS) {
    console.warn(
      `[webhook] skipping payload recording for ${projectKey}: queue is full (${recordingQueue.length})`,
    )
    return
  }

  recordingQueue.push({ projectKey, payload })
  drainRecordingQueue()
}

export const extractMrLabels = (payload: MrWebhookPayload): string[] => {
  if (payload.labels && payload.labels.length > 0) {
    return payload.labels.map((label) => label.title.trim()).filter((title) => title.length > 0)
  }

  if (payload.object_attributes.labels && payload.object_attributes.labels.length > 0) {
    return payload.object_attributes.labels
      .map((label) => label.title.trim())
      .filter((label) => label.length > 0)
  }

  return []
}

const classifyMrEvent = (
  project: GitLabProjectConfig,
  payload: MrWebhookPayload,
): ReviewWebhookEvent => {
  const { object_attributes: mr, changes } = payload

  if (mr.state !== 'opened') {
    return { type: 'ignored', reason: `mr state is "${mr.state}"` }
  }

  const trigger = project.trigger
  if (trigger.mode === 'ready') {
    const isOpenedAndReady =
      !mr.draft && (mr.action === 'open' || mr.action === 'update' || mr.action === 'reopen')
    const isDraftToReady =
      mr.action === 'update' &&
      changes?.draft?.previous === true &&
      changes?.draft?.current === false

    if (!isOpenedAndReady && !isDraftToReady) {
      return { type: 'ignored', reason: `action "${mr.action}", draft=${mr.draft}` }
    }
  } else if (trigger.mode === 'label') {
    return { type: 'ignored', reason: 'label trigger not yet implemented' }
  }

  return {
    type: 'mr_review_requested',
    projectKey: project.key,
    projectId: payload.project.id,
    mrIid: mr.iid,
    title: mr.title,
    description: mr.description ?? '',
    labels: extractMrLabels(payload),
    sourceBranch: mr.source_branch,
    targetBranch: mr.target_branch,
    url: mr.url,
  }
}

const classifyNoteEvent = (
  project: GitLabProjectConfig,
  payload: NoteWebhookPayload,
): ReviewWebhookEvent => {
  if (payload.object_attributes.noteable_type !== 'MergeRequest' || !payload.merge_request) {
    return { type: 'ignored', reason: 'note not on a merge request' }
  }

  return {
    type: 'mr_note_received',
    projectKey: project.key,
    projectId: payload.project.id,
    mrIid: payload.merge_request.iid,
    noteId: payload.object_attributes.id,
  }
}

export const classifyWebhook = (
  project: GitLabProjectConfig,
  payload: WebhookPayload,
): ReviewWebhookEvent => {
  switch (payload.object_kind) {
    case 'merge_request':
      return classifyMrEvent(project, payload)
    case 'note':
      return classifyNoteEvent(project, payload)
    default:
      return {
        type: 'ignored',
        reason: `unhandled object_kind "${(payload as { object_kind: string }).object_kind}"`,
      }
  }
}

export const createGitlabWebhookRoute = (config: AppConfig, mastra: Mastra) => {
  const { projects } = config
  const app = new Hono()

  app.post('/:projectKey', async (c) => {
    const projectKey = c.req.param('projectKey')
    const project = projects.get(projectKey)
    if (!project) {
      return c.json({ error: 'unknown project' }, 404)
    }
    if (project.platform !== 'gitlab') {
      return c.json({ error: 'unknown project' }, 404)
    }

    const token = c.req.header('X-Gitlab-Token')
    if (token !== project.webhook_secret) {
      return c.json({ error: 'unauthorized' }, 401)
    }

    const raw = await c.req.json()
    const parseResult = webhookPayloadSchema.safeParse(raw)
    if (!parseResult.success) {
      return c.json({ error: 'invalid payload', details: parseResult.error.issues }, 400)
    }
    const payload = parseResult.data

    if (config.env.RECORD_WEBHOOKS && c.req.header('X-Gitlab-Event')) {
      recordPayload(projectKey, payload)
    }

    const event = classifyWebhook(project, payload)

    if (event.type === 'mr_review_requested') {
      console.log(`[webhook] review requested: ${event.url} (${event.projectKey})`)
      enqueueMrReview({
        mastra,
        project,
        payload,
        event,
      }).catch((err: unknown) =>
        console.error(`[webhook] queue failure for ${event.projectKey} MR !${event.mrIid}:`, err),
      )
    } else if (event.type === 'mr_note_received') {
      console.log(
        `[webhook] note received for ${event.projectKey} MR !${event.mrIid} note ${event.noteId}`,
      )
      const notePayload = payload.object_kind === 'note' ? payload : null
      if (!notePayload) {
        return c.json({ error: 'invalid note payload' }, 400)
      }
      processReviewNoteEvent({
        project,
        mastra,
        payload: notePayload,
      }).catch((err: unknown) =>
        console.error(
          `[webhook] note processing failure for ${event.projectKey} MR !${event.mrIid} note ${event.noteId}:`,
          err,
        ),
      )
    }

    return c.json(event, 200)
  })

  return app
}
