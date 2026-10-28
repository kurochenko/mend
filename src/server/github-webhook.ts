import { Hono } from 'hono'
import { z } from 'zod'
import type { Mastra } from '@mastra/core'
import type { AppConfig, GitHubProjectConfig, ProjectConfig } from '@/config'
import { findTriggerIgnoreReason } from '@/server/review-trigger'
import { verifyGithubSignature } from '@/server/webhook-auth'
import { dispatchReviewWebhookEvent } from '@/server/webhook-dispatch'
import type { ReviewNote, ReviewWebhookEvent } from '@/server/webhook-events'
import { recordWebhookPayload } from '@/server/webhook-recording'

const REVIEWABLE_PULL_REQUEST_ACTIONS = new Set([
  'opened',
  'synchronize',
  'reopened',
  'ready_for_review',
])

const githubUserSchema = z.object({ id: z.number(), login: z.string() }).passthrough()
const githubLabelSchema = z.object({ name: z.string() }).passthrough()
const githubRepositorySchema = z.object({ id: z.number(), full_name: z.string() }).passthrough()

const commentSchema = z
  .object({
    id: z.number(),
    body: z.string(),
    user: githubUserSchema,
    html_url: z.string().optional(),
    created_at: z.string().optional(),
    updated_at: z.string().optional(),
  })
  .passthrough()

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
    comment: commentSchema,
  })
  .passthrough()

const reviewCommentPayloadSchema = z
  .object({
    action: z.string(),
    repository: githubRepositorySchema,
    pull_request: z.object({ number: z.number() }).passthrough(),
    comment: commentSchema,
  })
  .passthrough()

const findProject = (
  projects: Map<string, ProjectConfig>,
  fullName: string,
): GitHubProjectConfig | null => {
  for (const project of projects.values()) {
    if (project.platform === 'github' && project.repo.toLowerCase() === fullName.toLowerCase()) {
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

  if (pr.state !== 'open') {
    return { type: 'ignored', reason: `pull request state is "${pr.state}"` }
  }

  const triggerIgnoreReason = findTriggerIgnoreReason(project.trigger, {
    action: payload.action,
    reviewableAction: REVIEWABLE_PULL_REQUEST_ACTIONS.has(payload.action),
    draft: pr.draft,
  })
  if (triggerIgnoreReason) {
    return { type: 'ignored', reason: triggerIgnoreReason }
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
    headSha: pr.head.sha,
  }
}

const noteReceivedEvent = (params: {
  project: GitHubProjectConfig
  repositoryId: number
  prNumber: number
  comment: z.infer<typeof commentSchema>
  isDiffNote: boolean
}): ReviewWebhookEvent => {
  const { comment } = params
  const note: ReviewNote = {
    mrIid: params.prNumber,
    noteId: comment.id,
    body: comment.body,
    author: { id: comment.user.id, username: comment.user.login },
    isDiffNote: params.isDiffNote,
    url: comment.html_url,
    createdAt: comment.created_at,
    updatedAt: comment.updated_at,
  }
  return {
    type: 'mr_note_received',
    projectKey: params.project.key,
    projectId: params.repositoryId,
    note,
  }
}

export const classifyGithubIssueComment = (
  project: GitHubProjectConfig,
  payload: z.infer<typeof issueCommentPayloadSchema>,
): ReviewWebhookEvent => {
  if (payload.action !== 'created') {
    return { type: 'ignored', reason: `action "${payload.action}"` }
  }
  if (!payload.issue.pull_request) {
    return { type: 'ignored', reason: 'comment not on a pull request' }
  }

  return noteReceivedEvent({
    project,
    repositoryId: payload.repository.id,
    prNumber: payload.issue.number,
    comment: payload.comment,
    isDiffNote: false,
  })
}

export const classifyGithubReviewComment = (
  project: GitHubProjectConfig,
  payload: z.infer<typeof reviewCommentPayloadSchema>,
): ReviewWebhookEvent => {
  if (payload.action !== 'created') {
    return { type: 'ignored', reason: `action "${payload.action}"` }
  }

  return noteReceivedEvent({
    project,
    repositoryId: payload.repository.id,
    prNumber: payload.pull_request.number,
    comment: payload.comment,
    isDiffNote: true,
  })
}

const parseAndClassify = <T>(
  schema: z.ZodType<T>,
  raw: unknown,
  classify: (payload: T) => ReviewWebhookEvent,
): { event: ReviewWebhookEvent } | { issues: z.core.$ZodIssue[] } => {
  const parsed = schema.safeParse(raw)
  return parsed.success ? { event: classify(parsed.data) } : { issues: parsed.error.issues }
}

const classifyGithubEvent = (
  project: GitHubProjectConfig,
  eventName: string | undefined,
  raw: unknown,
): { event: ReviewWebhookEvent } | { issues: z.core.$ZodIssue[] } | null => {
  switch (eventName) {
    case 'pull_request':
      return parseAndClassify(pullRequestPayloadSchema, raw, (payload) =>
        classifyGithubPullRequest(project, payload),
      )
    case 'issue_comment':
      return parseAndClassify(issueCommentPayloadSchema, raw, (payload) =>
        classifyGithubIssueComment(project, payload),
      )
    case 'pull_request_review_comment':
      return parseAndClassify(reviewCommentPayloadSchema, raw, (payload) =>
        classifyGithubReviewComment(project, payload),
      )
    default:
      return null
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
    const authFailure = verifyGithubSignature(
      project.webhook_secret,
      rawBody,
      c.req.header('X-Hub-Signature-256'),
    )
    if (authFailure) {
      console.warn(`[webhook] rejected GitHub webhook for ${project.key}: ${authFailure}`)
      return c.json({ error: 'unauthorized' }, 401)
    }

    if (eventName === 'ping') {
      return c.json({ ok: true }, 200)
    }

    const result = classifyGithubEvent(project, eventName, raw)
    if (!result) {
      return c.json({ type: 'ignored', reason: `event "${eventName}"` }, 200)
    }
    if ('issues' in result) {
      return c.json({ error: 'invalid payload', details: result.issues }, 400)
    }

    if (config.env.RECORD_WEBHOOKS && eventName) {
      recordWebhookPayload({ projectKey: project.key, eventKind: eventName, payload: raw })
    }

    const { event } = result
    dispatchReviewWebhookEvent({ mastra, project, event, rawPayload: raw })
    return c.json(event, 200)
  })

  return app
}
