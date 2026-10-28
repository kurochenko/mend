import { createHmac } from 'node:crypto'
import { afterEach, describe, expect, mock, test } from 'bun:test'
import type { Mastra } from '@mastra/core'
import type { AppConfig, GitHubProjectConfig } from '@/config'
import {
  classifyGithubIssueComment,
  classifyGithubPullRequest,
  classifyGithubReviewComment,
  createGithubWebhookRoute,
} from '@/server/github-webhook'
import { verifyGithubSignature } from '@/server/webhook-auth'

const project = {
  key: 'repo',
  platform: 'github',
  url: 'https://github.com',
  token: 'token',
  webhook_secret: 'secret',
  repo: 'org/repo',
  repo_url: 'git@github.com:org/repo.git',
  default_branch: 'main',
  clone_path: '/tmp/repo',
  trigger: { mode: 'ready' },
  tools: { context7: {} },
  review: {
    llm: { model: 'model', thinking_level: 'medium' },
    agent: { harness: 'pi' },
    flags: {
      structured_findings_post: true,
      structural_signals: true,
      bug_history: true,
      dry_run: false,
    },
    comparison: { enabled: false, harness: 'opencode', timeout_ms: 300_000 },
    memory: { project_scope_usernames: [] },
  },
} satisfies GitHubProjectConfig

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

const pullRequestPayload = (overrides: Record<string, unknown> = {}) => ({
  action: 'opened',
  repository: { id: 123, full_name: 'org/repo' },
  pull_request: {
    number: 42,
    title: 'Test PR',
    body: 'body',
    draft: false,
    state: 'open',
    merged: false,
    labels: [{ name: 'bug' }],
    head: { ref: 'feature/test', sha: 'abc123' },
    base: { ref: 'main' },
    html_url: 'https://github.com/org/repo/pull/42',
  },
  ...overrides,
})

describe('verifyGithubSignature', () => {
  test('accepts valid signature and rejects invalid or missing signature', () => {
    const body = '{"ok":true}'
    const signature = `sha256=${createHmac('sha256', 'secret').update(body).digest('hex')}`

    expect(verifyGithubSignature('secret', body, signature)).toBeNull()
    expect(verifyGithubSignature('secret', body, 'sha256=bad')).toBe('signature_mismatch')
    expect(verifyGithubSignature('secret', body, undefined)).toBe('missing_signature_headers')
  })
})

describe('classifyGithubPullRequest', () => {
  test('normalizes opened PR to review request', () => {
    const event = classifyGithubPullRequest(project, pullRequestPayload())

    expect(event).toMatchObject({
      type: 'mr_review_requested',
      projectKey: 'repo',
      projectId: 123,
      mrIid: 42,
      labels: ['bug'],
      sourceBranch: 'feature/test',
      targetBranch: 'main',
      headSha: 'abc123',
    })
  })

  test('ready trigger skips drafts', () => {
    const event = classifyGithubPullRequest(
      project,
      pullRequestPayload({
        pull_request: {
          ...pullRequestPayload().pull_request,
          draft: true,
        },
      }),
    )

    expect(event.type).toBe('ignored')
  })

  test('closed PR is ignored', () => {
    const event = classifyGithubPullRequest(project, pullRequestPayload({ action: 'closed' }))

    expect(event).toEqual({ type: 'ignored', reason: 'pull request closed' })
  })
})

describe('classifyGithubIssueComment', () => {
  test('normalizes PR issue comments to note events', () => {
    const event = classifyGithubIssueComment(project, {
      action: 'created',
      repository: { id: 123, full_name: 'org/repo' },
      issue: { number: 42, pull_request: {} },
      comment: {
        id: 99,
        body: '@mend hello',
        user: { id: 7, login: 'alice' },
        html_url: 'https://github.com/org/repo/pull/42#issuecomment-99',
      },
    })

    expect(event).toEqual({
      type: 'mr_note_received',
      projectKey: 'repo',
      projectId: 123,
      note: {
        mrIid: 42,
        noteId: 99,
        body: '@mend hello',
        author: { id: 7, username: 'alice' },
        isDiffNote: false,
        url: 'https://github.com/org/repo/pull/42#issuecomment-99',
        createdAt: undefined,
        updatedAt: undefined,
      },
    })
  })
})

describe('classifyGithubReviewComment', () => {
  test('defers thread lookup to asynchronous note processing', () => {
    const fetchMock = mock()
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const event = classifyGithubReviewComment(project, {
      action: 'created',
      repository: { id: 123, full_name: 'org/repo' },
      pull_request: { number: 42 },
      comment: {
        id: 99,
        body: 'reply',
        user: { id: 7, login: 'alice' },
        html_url: 'https://github.com/org/repo/pull/42#discussion_r99',
      },
    })

    expect(event).toMatchObject({
      type: 'mr_note_received',
      note: { mrIid: 42, noteId: 99, isDiffNote: true },
    })
    expect(event.type === 'mr_note_received' && event.note.discussionId).toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('github webhook route', () => {
  const sign = (body: string) =>
    `sha256=${createHmac('sha256', 'secret').update(body).digest('hex')}`

  const createApp = () =>
    createGithubWebhookRoute(
      { projects: new Map([['repo', project]]) } as unknown as AppConfig,
      {} as Mastra,
    )

  const post = (body: string, event: string, signature?: string) =>
    createApp().request('/', {
      method: 'POST',
      headers: {
        'X-GitHub-Event': event,
        ...(signature ? { 'X-Hub-Signature-256': signature } : {}),
      },
      body,
    })

  test('responds to ping with a valid signature', async () => {
    const body = JSON.stringify({ zen: 'ok', repository: { id: 123, full_name: 'org/repo' } })
    const res = await post(body, 'ping', sign(body))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  test('matches configured repository names case-insensitively', async () => {
    const configuredProject = { ...project, repo: 'ORG/REPO' }
    const app = createGithubWebhookRoute(
      { projects: new Map([['repo', configuredProject]]) } as unknown as AppConfig,
      {} as Mastra,
    )
    const body = JSON.stringify({ zen: 'ok', repository: { id: 123, full_name: 'org/repo' } })
    const res = await app.request('/', {
      method: 'POST',
      headers: {
        'X-GitHub-Event': 'ping',
        'X-Hub-Signature-256': sign(body),
      },
      body,
    })

    expect(res.status).toBe(200)
  })

  test('rejects invalid signatures', async () => {
    const body = JSON.stringify({ repository: { id: 123, full_name: 'org/repo' } })
    const res = await post(body, 'ping', 'sha256=bad')

    expect(res.status).toBe(401)
  })

  test('rejects missing signatures', async () => {
    const body = JSON.stringify({ repository: { id: 123, full_name: 'org/repo' } })
    const res = await post(body, 'ping')

    expect(res.status).toBe(401)
  })

  test('ignores unsupported events', async () => {
    const body = JSON.stringify({ repository: { id: 123, full_name: 'org/repo' } })
    const res = await post(body, 'push', sign(body))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ type: 'ignored', reason: 'event "push"' })
  })

  test('rejects a supported event with an invalid payload', async () => {
    const body = JSON.stringify({
      action: 'opened',
      repository: { id: 123, full_name: 'org/repo' },
    })
    const res = await post(body, 'pull_request', sign(body))

    expect(res.status).toBe(400)
  })

  test('rejects unknown repositories', async () => {
    const body = JSON.stringify({ repository: { id: 1, full_name: 'other/repo' } })
    const res = await post(body, 'ping', sign(body))

    expect(res.status).toBe(404)
  })

  test('rejects invalid JSON payloads', async () => {
    const res = await post('not json', 'ping', sign('not json'))

    expect(res.status).toBe(400)
  })
})
