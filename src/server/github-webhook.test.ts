import { createHmac } from 'node:crypto'
import { afterEach, describe, expect, mock, test } from 'bun:test'
import type { GitHubProjectConfig } from '@/config'
import {
  classifyGithubIssueComment,
  classifyGithubPullRequest,
  classifyGithubReviewComment,
  verifyGithubSignature,
} from '@/server/github-webhook'

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
    template: { prompt: 'auto', label_prefix: 'ai-review:' },
    flags: {
      prompt_templates_v2: true,
      schema_v2: true,
      structured_findings_post: true,
      structural_signals: true,
      bug_history: true,
      dry_run: false,
    },
    intent: {
      harness: 'pi',
      model: 'model',
      thinking_level: 'minimal',
      timeout_ms: 45_000,
      failure_policy: 'mixed',
    },
    comparison: { enabled: false, harness: 'opencode', timeout_ms: 300_000 },
    memory: { project_scope_usernames: [] },
    triage: { trusted_usernames: [] },
    fix: { enabled: false, automatic: false, max_loops: 3 },
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
    head: { ref: 'feature/test' },
    base: { ref: 'main' },
    html_url: 'https://github.com/org/repo/pull/42',
  },
  ...overrides,
})

describe('verifyGithubSignature', () => {
  test('accepts valid signature and rejects invalid or missing signature', () => {
    const body = '{"ok":true}'
    const signature = `sha256=${createHmac('sha256', 'secret').update(body).digest('hex')}`

    expect(verifyGithubSignature('secret', body, signature)).toBe(true)
    expect(verifyGithubSignature('secret', body, 'sha256=bad')).toBe(false)
    expect(verifyGithubSignature('secret', body, undefined)).toBe(false)
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
    const result = classifyGithubIssueComment(project, {
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

    expect(result.event).toEqual({
      type: 'mr_note_received',
      projectKey: 'repo',
      projectId: 123,
      mrIid: 42,
      noteId: 99,
    })
    expect(result.payload?.object_attributes.discussion_id).toBeNull()
    expect(result.payload?.user.username).toBe('alice')
  })
})

describe('classifyGithubReviewComment', () => {
  test('resolves discussion id from provider threads when possible', async () => {
    const fetchMock = mock()
      .mockImplementationOnce(
        async () =>
          new Response(
            JSON.stringify({
              data: {
                repository: {
                  pullRequest: {
                    reviewThreads: {
                      nodes: [
                        {
                          id: 'thread-node',
                          isResolved: false,
                          comments: {
                            nodes: [
                              {
                                id: 'comment-node',
                                databaseId: 99,
                                body: 'inline',
                                author: { login: 'alice', databaseId: 7 },
                                path: 'src/app.ts',
                                line: 1,
                                originalLine: 1,
                              },
                            ],
                          },
                        },
                      ],
                      pageInfo: { hasNextPage: false, endCursor: null },
                    },
                  },
                },
              },
            }),
          ),
      )
      .mockImplementationOnce(async () => new Response('[]'))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const result = await classifyGithubReviewComment(project, {
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

    expect(result.payload?.object_attributes.discussion_id).toBe('thread-node')
  })
})
