import { Hono } from 'hono'
import { z } from 'zod'
import type { Mastra } from '@mastra/core'
import type { AppConfig, GitLabProjectConfig } from '@/config'
import { findTriggerIgnoreReason } from '@/server/review-trigger'
import { findGitlabWebhookAuthFailure } from '@/server/webhook-auth'
import { dispatchReviewWebhookEvent } from '@/server/webhook-dispatch'
import type { ReviewWebhookEvent } from '@/server/webhook-events'
import { recordWebhookPayload } from '@/server/webhook-recording'

const REVIEWABLE_MR_ACTIONS = new Set(['open', 'update', 'reopen'])

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
    last_commit: z.object({ id: z.string() }).passthrough().optional(),
  })
  .passthrough()

const mrWebhookPayloadSchema = z
  .object({
    object_kind: z.literal('merge_request'),
    project: gitlabProjectSchema,
    object_attributes: mrObjectAttributesSchema,
    labels: z.array(z.object({ title: z.string() }).passthrough()).optional(),
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
  const mr = payload.object_attributes

  if (mr.state !== 'opened') {
    return { type: 'ignored', reason: `mr state is ${JSON.stringify(mr.state)}` }
  }
  const triggerIgnoreReason = findTriggerIgnoreReason(project.trigger, {
    action: mr.action,
    reviewableAction: REVIEWABLE_MR_ACTIONS.has(mr.action),
    draft: mr.draft,
  })
  if (triggerIgnoreReason) {
    return { type: 'ignored', reason: triggerIgnoreReason }
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
    headSha: mr.last_commit?.id ?? null,
  }
}

const classifyNoteEvent = (
  project: GitLabProjectConfig,
  payload: NoteWebhookPayload,
): ReviewWebhookEvent => {
  const note = payload.object_attributes
  if (note.noteable_type !== 'MergeRequest' || !payload.merge_request) {
    return { type: 'ignored', reason: 'note not on a merge request' }
  }
  if (note.system) {
    return { type: 'ignored', reason: 'system note' }
  }
  if (note.action !== undefined && note.action !== 'create') {
    return { type: 'ignored', reason: `note action ${JSON.stringify(note.action)}` }
  }

  return {
    type: 'mr_note_received',
    projectKey: project.key,
    projectId: payload.project.id,
    note: {
      mrIid: payload.merge_request.iid,
      noteId: note.id,
      body: note.note,
      author: { id: payload.user.id, username: payload.user.username },
      discussionId: note.discussion_id,
      isDiffNote: note.type === 'DiffNote',
      url: note.url,
      createdAt: note.created_at,
      updatedAt: note.updated_at,
    },
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
  }
}

const handledObjectKinds = new Set(['merge_request', 'note'])

const unhandledObjectKind = (raw: unknown): string | null => {
  const objectKind =
    raw !== null && typeof raw === 'object' ? (raw as { object_kind?: unknown }).object_kind : null
  return typeof objectKind === 'string' && !handledObjectKinds.has(objectKind) ? objectKind : null
}

type ParsedWebhookBody =
  | { type: 'invalid'; details?: unknown }
  | { type: 'unhandled'; objectKind: string }
  | { type: 'payload'; payload: WebhookPayload; raw: unknown }

const parseWebhookBody = (rawBody: string): ParsedWebhookBody => {
  let raw: unknown
  try {
    raw = JSON.parse(rawBody)
  } catch {
    return { type: 'invalid' }
  }

  const objectKind = unhandledObjectKind(raw)
  if (objectKind !== null) {
    return { type: 'unhandled', objectKind }
  }

  const parseResult = webhookPayloadSchema.safeParse(raw)
  return parseResult.success
    ? { type: 'payload', payload: parseResult.data, raw }
    : { type: 'invalid', details: parseResult.error.issues }
}

const logWebhookOutcome = (
  projectKey: string,
  gitlabEvent: string | undefined,
  outcome: string,
): void => {
  console.log(`[webhook] ${projectKey} ${JSON.stringify(gitlabEvent ?? '')} ${outcome}`)
}

const payloadMrIid = (payload: WebhookPayload): number | undefined =>
  payload.object_kind === 'merge_request'
    ? payload.object_attributes.iid
    : payload.merge_request?.iid

const logIgnoredWebhook = (
  projectKey: string,
  gitlabEvent: string | undefined,
  payload: WebhookPayload,
  reason: string,
): void => {
  const mrIid = payloadMrIid(payload)
  const mrLabel = mrIid === undefined ? '' : ` MR !${mrIid}`
  logWebhookOutcome(projectKey, gitlabEvent, `200 ignored${mrLabel}: ${reason}`)
}

export const createGitlabWebhookRoute = (config: AppConfig, mastra: Mastra) => {
  const { projects } = config
  const app = new Hono()

  app.onError((err, c) => {
    logWebhookOutcome(
      c.req.param('projectKey') ?? '',
      c.req.header('X-Gitlab-Event'),
      '500 internal error',
    )
    console.error('[webhook] request failed:', err)
    return c.json({ error: 'internal error' }, 500)
  })

  app.post('/:projectKey', async (c) => {
    const projectKey = c.req.param('projectKey')
    const gitlabEvent = c.req.header('X-Gitlab-Event')
    const project = projects.get(projectKey)
    if (project?.platform !== 'gitlab') {
      logWebhookOutcome(JSON.stringify(projectKey), gitlabEvent, '404 unknown project')
      return c.json({ error: 'unknown project' }, 404)
    }

    const rawBody = await c.req.text()
    const authFailure = findGitlabWebhookAuthFailure(project, (name) => c.req.header(name), rawBody)
    if (authFailure) {
      logWebhookOutcome(projectKey, gitlabEvent, `401 unauthorized (${authFailure})`)
      return c.json({ error: 'unauthorized' }, 401)
    }

    const parsedBody = parseWebhookBody(rawBody)
    if (parsedBody.type === 'invalid') {
      logWebhookOutcome(projectKey, gitlabEvent, '400 invalid payload')
      return c.json({ error: 'invalid payload', details: parsedBody.details }, 400)
    }
    if (parsedBody.type === 'unhandled') {
      const reason = `unhandled object_kind ${JSON.stringify(parsedBody.objectKind)}`
      logWebhookOutcome(projectKey, gitlabEvent, `200 ignored: ${reason}`)
      return c.json({ type: 'ignored', reason }, 200)
    }
    const { payload, raw } = parsedBody

    if (config.env.RECORD_WEBHOOKS && gitlabEvent) {
      recordWebhookPayload({ projectKey, eventKind: payload.object_kind, payload: raw })
    }

    const event = classifyWebhook(project, payload)
    if (event.type === 'ignored') {
      logIgnoredWebhook(projectKey, gitlabEvent, payload, event.reason)
    }
    dispatchReviewWebhookEvent({ mastra, project, event, rawPayload: raw })
    return c.json(event, 200)
  })

  return app
}
