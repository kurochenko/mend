import { createHmac, timingSafeEqual } from 'node:crypto'
import { Hono } from 'hono'
import { z } from 'zod'
import type { Mastra } from '@mastra/core'
import type { AppConfig, GitHubProjectConfig } from '@/config'
import { enqueueMrReview } from '@/server/mr-review-queue'
import { processReviewNoteEvent } from '@/server/review-note-events'
import type { ReviewNoteEventPayload, ReviewWebhookEvent } from '@/server/webhook-events'

const githubUserSchema = z.object({ id: z.number(), login: z.string() }).passthrough()
const githubLabelSchema = z.object({ name: z.string() }).passthrough()
const githubRepositorySchema = z.object({ id: z.number(), full_name: z.string() }).passthrough()

const pullRequestSchema = z
  .object({
    number: z.number(),
    title: z.string(),
    body: z.string().nullable(),
    draft: z.boolean(),
    state: z.string(),
    merged: z.boolean().optional(),
    labels: z.array(githubLabelSchema),
    head: z.object({ ref: z.string(), sha: z.string() }).passthrough(),
    base: z.object({ ref: z.string() }).passthrough(),
    html_url: z.string(),
  })
  .passthrough()

const pullRequestPayloadSchema = z
  .object({
    action: z.string(),
    repository: githubRepositorySchema,
    pull_request: pullRequestSchema,
  })
  .passthrough()

const issueCommentPayloadSchema = z
  .object({
    action: z.string(),
    repository: githubRepositorySchema,
    issue: z.object({ number: z.number(), pull_request: z.unknown().optional() }).passthrough(),
    comment: z
      .object({
        id: z.number(),
        body: z.string(),
        user: githubUserSchema,
        html_url: z.string().optional(),
        created_at: z.string().optional(),
        updated_at: z.string().optional(),
      })
      .passthrough(),
  })
  .passthrough()

const reviewCommentPayloadSchema = z
  .object({
    action: z.string(),
    repository: githubRepositorySchema,
    pull_request: z.object({ number: z.number() }).passthrough(),
    comment: z
      .object({
        id: z.number(),
        body: z.string(),
        user: githubUserSchema,
        html_url: z.string().optional(),
        created_at: z.string().optional(),
        updated_at: z.string().optional(),
      })
      .passthrough(),
  })
  .passthrough()

export const verifyGithubSignature = (
  secret: string,
  rawBody: string,
  signature: string | undefined,
): boolean => {
  if (!signature?.startsWith('sha256=')) {
    return false
  }

  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`
  const actualBuffer = Buffer.from(signature)
  const expectedBuffer = Buffer.from(expected)
  return (
    actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer)
  )
}

const findProject = (
  projects: Map<string, AppConfig['projects'] extends Map<string, infer T> ? T : never>,
  fullName: string,
): GitHubProjectConfig | null => {
  for (const project of projects.values()) {
    if (project.platform === 'github' && project.repo === fullName) {
      return project
    }
  }

  return null
}

export const classifyGithubPullRequest = (
  project: GitHubProjectConfig,
  payload: z.infer<typeof pullRequestPayloadSchema>,
): ReviewWebhookEvent => {
  const pr = payload.pull_request
  if (payload.action === 'closed') {
    return { type: 'ignored', reason: pr.merged ? 'pull request merged' : 'pull request closed' }
  }

  if (!['opened', 'synchronize', 'reopened', 'ready_for_review'].includes(payload.action)) {
    return { type: 'ignored', reason: `action "${payload.action}"` }
  }

  if (pr.state !== 'open') {
    return { type: 'ignored', reason: `pull request state is "${pr.state}"` }
  }

  const trigger = project.trigger
  if (trigger.mode === 'ready' && pr.draft) {
    return { type: 'ignored', reason: `action "${payload.action}", draft=${pr.draft}` }
  }
  if (trigger.mode === 'label') {
    return { type: 'ignored', reason: 'label trigger not yet implemented' }
  }

  return {
    type: 'mr_review_requested',
    projectKey: project.key,
    projectId: payload.repository.id,
    mrIid: pr.number,
    title: pr.title,
    description: pr.body ?? '',
    labels: pr.labels.map((label) => label.name),
    sourceBranch: pr.head.ref,
    targetBranch: pr.base.ref,
    url: pr.html_url,
  }
}

const notePayload = (params: {
  repositoryId: number
  prNumber: number
  noteId: number
  body: string
  user: { id: number; login: string }
  url?: string
  createdAt?: string
  updatedAt?: string
  inline: boolean
}): ReviewNoteEventPayload => ({
  project: { id: params.repositoryId },
  user: { id: params.user.id, username: params.user.login },
  merge_request: { iid: params.prNumber },
  object_attributes: {
    id: params.noteId,
    note: params.body,
    noteable_type: 'MergeRequest',
    discussion_id: null,
    type: params.inline ? 'DiffNote' : null,
    action: 'create',
    url: params.url,
    created_at: params.createdAt,
    updated_at: params.updatedAt,
    system: false,
  },
})

export const classifyGithubIssueComment = (
  project: GitHubProjectConfig,
  payload: z.infer<typeof issueCommentPayloadSchema>,
): { event: ReviewWebhookEvent; payload: ReviewNoteEventPayload | null } => {
  if (payload.action !== 'created') {
    return { event: { type: 'ignored', reason: `action "${payload.action}"` }, payload: null }
  }
  if (!payload.issue.pull_request) {
    return { event: { type: 'ignored', reason: 'comment not on a pull request' }, payload: null }
  }

  const normalized = notePayload({
    repositoryId: payload.repository.id,
    prNumber: payload.issue.number,
    noteId: payload.comment.id,
    body: payload.comment.body,
    user: payload.comment.user,
    url: payload.comment.html_url,
    createdAt: payload.comment.created_at,
    updatedAt: payload.comment.updated_at,
    inline: false,
  })

  return {
    event: {
      type: 'mr_note_received',
      projectKey: project.key,
      projectId: payload.repository.id,
      mrIid: payload.issue.number,
      noteId: payload.comment.id,
    },
    payload: normalized,
  }
}

export const classifyGithubReviewComment = (
  project: GitHubProjectConfig,
  payload: z.infer<typeof reviewCommentPayloadSchema>,
): { event: ReviewWebhookEvent; payload: ReviewNoteEventPayload | null } => {
  if (payload.action !== 'created') {
    return { event: { type: 'ignored', reason: `action "${payload.action}"` }, payload: null }
  }

  const normalized = notePayload({
    repositoryId: payload.repository.id,
    prNumber: payload.pull_request.number,
    noteId: payload.comment.id,
    body: payload.comment.body,
    user: payload.comment.user,
    url: payload.comment.html_url,
    createdAt: payload.comment.created_at,
    updatedAt: payload.comment.updated_at,
    inline: true,
  })

  return {
    event: {
      type: 'mr_note_received',
      projectKey: project.key,
      projectId: payload.repository.id,
      mrIid: payload.pull_request.number,
      noteId: payload.comment.id,
    },
    payload: normalized,
  }
}

export const createGithubWebhookRoute = (config: AppConfig, mastra: Mastra) => {
  const app = new Hono()

  app.post('/', async (c) => {
    const eventName = c.req.header('X-GitHub-Event')
    const rawBody = await c.req.text()
    let raw: unknown
    try {
      raw = JSON.parse(rawBody)
    } catch {
      return c.json({ error: 'invalid payload' }, 400)
    }
    const repository = z.object({ repository: githubRepositorySchema }).safeParse(raw)
    if (!repository.success) {
      return c.json({ error: 'invalid payload' }, 400)
    }

    const project = findProject(config.projects, repository.data.repository.full_name)
    if (!project) {
      return c.json({ error: 'unknown project' }, 404)
    }
    if (
      !verifyGithubSignature(project.webhook_secret, rawBody, c.req.header('X-Hub-Signature-256'))
    ) {
      return c.json({ error: 'unauthorized' }, 401)
    }

    if (eventName === 'ping') {
      return c.json({ ok: true }, 200)
    }

    let event: ReviewWebhookEvent = { type: 'ignored', reason: `event "${eventName}"` }
    let normalizedNotePayload: ReviewNoteEventPayload | null = null

    if (eventName === 'pull_request') {
      const parseResult = pullRequestPayloadSchema.safeParse(raw)
      if (!parseResult.success) {
        return c.json({ error: 'invalid payload', details: parseResult.error.issues }, 400)
      }
      event = classifyGithubPullRequest(project, parseResult.data)
    } else if (eventName === 'issue_comment') {
      const parseResult = issueCommentPayloadSchema.safeParse(raw)
      if (!parseResult.success) {
        return c.json({ error: 'invalid payload', details: parseResult.error.issues }, 400)
      }
      const result = classifyGithubIssueComment(project, parseResult.data)
      event = result.event
      normalizedNotePayload = result.payload
    } else if (eventName === 'pull_request_review_comment') {
      const parseResult = reviewCommentPayloadSchema.safeParse(raw)
      if (!parseResult.success) {
        return c.json({ error: 'invalid payload', details: parseResult.error.issues }, 400)
      }
      const result = classifyGithubReviewComment(project, parseResult.data)
      event = result.event
      normalizedNotePayload = result.payload
    }

    if (event.type === 'mr_review_requested') {
      console.log(`[webhook] review requested: ${event.url} (${event.projectKey})`)
      enqueueMrReview({
        mastra,
        project,
        payload: raw,
        event,
      }).catch((err: unknown) =>
        console.error(`[webhook] queue failure for ${event.projectKey} MR !${event.mrIid}:`, err),
      )
    } else if (event.type === 'mr_note_received' && normalizedNotePayload) {
      console.log(
        `[webhook] note received for ${event.projectKey} MR !${event.mrIid} note ${event.noteId}`,
      )
      processReviewNoteEvent({
        project,
        mastra,
        payload: normalizedNotePayload,
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
