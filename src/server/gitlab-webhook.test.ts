import { createHmac } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import type { Mastra } from '@mastra/core'
import type { AppConfig, GitLabProjectConfig } from '@/config'
import {
  classifyWebhook,
  createGitlabWebhookRoute,
  extractMrLabels,
  type MrWebhookPayload,
  type WebhookPayload,
} from '@/server/gitlab-webhook'
import { verifyGitlabSignature } from '@/server/webhook-auth'

const makeProject = (overrides: Partial<GitLabProjectConfig> = {}): GitLabProjectConfig => ({
  key: 'test-project',
  platform: 'gitlab',
  url: 'https://gitlab.example.com',
  token: 'test-token',
  webhook_secret: 'secret',
  project_id: 1,
  repo_url: 'https://gitlab.example.com/test/repo.git',
  default_branch: 'main',
  clone_path: '/tmp/test',
  trigger: { mode: 'ready' },
  review: {
    llm: { model: 'test-model', thinking_level: 'medium' },
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
  tools: { context7: {} },
  ...overrides,
})

const makeMrPayload = (
  overrides: {
    action?: string
    draft?: boolean
    state?: string
    changes?: Record<string, unknown>
    labels?: Array<{ title: string }>
    objectLabels?: Array<{ title: string }>
  } = {},
): MrWebhookPayload => ({
  object_kind: 'merge_request' as const,
  project: { id: 1, name: 'test', web_url: 'https://gitlab.example.com/test' },
  object_attributes: {
    iid: 42,
    title: 'Test MR',
    description: 'A test merge request',
    labels: overrides.objectLabels,
    source_branch: 'feature/test',
    target_branch: 'main',
    state: overrides.state ?? 'opened',
    action: overrides.action ?? 'open',
    draft: overrides.draft ?? false,
    url: 'https://gitlab.example.com/test/-/merge_requests/42',
    last_commit: { id: 'abc123' },
  },
  labels: overrides.labels,
  changes: overrides.changes,
})

const makeNotePayload = (
  overrides: {
    noteableType?: string
    hasMr?: boolean
    noteId?: number
    action?: string
    system?: boolean
    type?: string | null
    discussionId?: string
  } = {},
): WebhookPayload => ({
  object_kind: 'note' as const,
  project: { id: 1, name: 'test', web_url: 'https://gitlab.example.com/test' },
  user: { id: 2, username: 'reviewer' },
  object_attributes: {
    id: overrides.noteId ?? 99,
    note: 'Some comment',
    noteable_type: overrides.noteableType ?? 'MergeRequest',
    type: overrides.type ?? null,
    action: overrides.action ?? 'create',
    system: overrides.system,
    discussion_id: overrides.discussionId,
  },
  ...(overrides.hasMr !== false ? { merge_request: { iid: 42 } } : {}),
})

describe('classifyWebhook', () => {
  describe('merge request events', () => {
    test('MR opened, non-draft, state=opened, mode=ready → mr_review_requested', () => {
      const project = makeProject({ trigger: { mode: 'ready' } })
      const payload = makeMrPayload({ action: 'open', draft: false, state: 'opened' })

      const result = classifyWebhook(project, payload)

      expect(result.type).toBe('mr_review_requested')
      if (result.type === 'mr_review_requested') {
        expect(result.mrIid).toBe(42)
        expect(result.projectKey).toBe('test-project')
        expect(result.headSha).toBe('abc123')
      }
    })

    test('MR opened, draft=true, mode=ready → ignored', () => {
      const project = makeProject({ trigger: { mode: 'ready' } })
      const payload = makeMrPayload({ action: 'open', draft: true, state: 'opened' })

      const result = classifyWebhook(project, payload)

      expect(result.type).toBe('ignored')
    })

    test('MR state=closed → ignored', () => {
      const project = makeProject({ trigger: { mode: 'ready' } })
      const payload = makeMrPayload({ action: 'open', draft: false, state: 'closed' })

      const result = classifyWebhook(project, payload)

      expect(result.type).toBe('ignored')
      if (result.type === 'ignored') {
        expect(result.reason).toContain('closed')
      }
    })

    test('MR action=update, draft changed true→false (mark ready) → mr_review_requested', () => {
      const project = makeProject({ trigger: { mode: 'ready' } })
      const payload = makeMrPayload({
        action: 'update',
        draft: false,
        state: 'opened',
        changes: { draft: { previous: true, current: false } },
      })

      const result = classifyWebhook(project, payload)

      expect(result.type).toBe('mr_review_requested')
    })

    test('MR action=update, no draft change, mode=ready → mr_review_requested', () => {
      const project = makeProject({ trigger: { mode: 'ready' } })
      const payload = makeMrPayload({
        action: 'update',
        draft: false,
        state: 'opened',
      })

      const result = classifyWebhook(project, payload)

      expect(result.type).toBe('mr_review_requested')
    })

    test('mode=all accepts any action when state=opened', () => {
      const project = makeProject({ trigger: { mode: 'all' } })
      const payload = makeMrPayload({
        action: 'update',
        draft: true,
        state: 'opened',
      })

      const result = classifyWebhook(project, payload)

      expect(result.type).toBe('mr_review_requested')
    })
  })

  describe('trigger actions', () => {
    test('mode=all ignores non-push MR actions such as approvals', () => {
      const project = makeProject({ trigger: { mode: 'all' } })
      const payload = makeMrPayload({ action: 'approved', draft: false, state: 'opened' })

      expect(classifyWebhook(project, payload)).toEqual({
        type: 'ignored',
        reason: 'action "approved"',
      })
    })
  })

  describe('note events', () => {
    test('note event on MR -> mr_note_received', () => {
      const project = makeProject()
      const payload = makeNotePayload({ noteableType: 'MergeRequest', hasMr: true })

      const result = classifyWebhook(project, payload)

      expect(result).toEqual({
        type: 'mr_note_received',
        projectKey: 'test-project',
        projectId: 1,
        note: {
          mrIid: 42,
          noteId: 99,
          body: 'Some comment',
          author: { id: 2, username: 'reviewer' },
          discussionId: undefined,
          isDiffNote: false,
          url: undefined,
          createdAt: undefined,
          updatedAt: undefined,
        },
      })
    })

    test('diff note keeps its discussion id', () => {
      const payload = makeNotePayload({ type: 'DiffNote', discussionId: 'discussion-abc' })

      const result = classifyWebhook(makeProject(), payload)

      expect(result).toMatchObject({
        type: 'mr_note_received',
        note: { isDiffNote: true, discussionId: 'discussion-abc' },
      })
    })

    test('system note → ignored', () => {
      const result = classifyWebhook(makeProject(), makeNotePayload({ system: true }))

      expect(result).toEqual({ type: 'ignored', reason: 'system note' })
    })

    test('edited note → ignored', () => {
      const result = classifyWebhook(makeProject(), makeNotePayload({ action: 'update' }))

      expect(result).toEqual({ type: 'ignored', reason: 'note action "update"' })
    })

    test('note event not on MR → ignored', () => {
      const project = makeProject()
      const payload = makeNotePayload({ noteableType: 'Issue', hasMr: false })

      const result = classifyWebhook(project, payload)

      expect(result.type).toBe('ignored')
      if (result.type === 'ignored') {
        expect(result.reason).toContain('not on a merge request')
      }
    })
  })
})

describe('extractMrLabels', () => {
  test('extracts from top-level labels array', () => {
    const payload = makeMrPayload({
      labels: [{ title: 'bug' }, { title: 'review' }],
    })

    const result = extractMrLabels(payload)

    expect(result).toEqual(['bug', 'review'])
  })

  test('falls back to object_attributes.labels', () => {
    const payload = makeMrPayload({
      objectLabels: [{ title: 'urgent' }, { title: 'backend' }],
    })

    const result = extractMrLabels(payload)

    expect(result).toEqual(['urgent', 'backend'])
  })

  test('returns empty array when no labels present', () => {
    const payload = makeMrPayload()

    const result = extractMrLabels(payload)

    expect(result).toEqual([])
  })

  test('trims and filters empty label titles', () => {
    const payload = makeMrPayload({
      labels: [{ title: '  bug  ' }, { title: '' }, { title: 'review' }],
    })

    const result = extractMrLabels(payload)

    expect(result).toEqual(['bug', 'review'])
  })
})

describe('gitlab webhook route authentication', () => {
  const signingKey = Buffer.from('test-signing-key')
  const body = JSON.stringify(makeMrPayload({ draft: true }))
  const messageId = 'msg_1'

  const sign = (timestamp: string, payload = body) =>
    `v1,${createHmac('sha256', signingKey).update(`${messageId}.${timestamp}.${payload}`).digest('base64')}`

  const nowTimestamp = () => String(Math.floor(Date.now() / 1000))

  const post = (headers: Record<string, string>, project = makeProject()) =>
    createGitlabWebhookRoute(
      { projects: new Map([[project.key, project]]), env: {} } as unknown as AppConfig,
      {} as Mastra,
    ).request(`/${project.key}`, { method: 'POST', headers, body })

  const signedHeaders = (timestamp: string, signature = sign(timestamp)) => ({
    'webhook-id': messageId,
    'webhook-timestamp': timestamp,
    'webhook-signature': signature,
  })

  test('accepts a valid signature when a signing token is configured', async () => {
    const res = await post(
      signedHeaders(nowTimestamp()),
      makeProject({ webhook_signing_token: signingKey }),
    )

    expect(res.status).toBe(200)
    expect(((await res.json()) as { type: string }).type).toBe('ignored')
  })

  test('accepts a valid signature among multiple space-separated signatures', async () => {
    const timestamp = nowTimestamp()
    const res = await post(
      signedHeaders(timestamp, `v1,bogus ${sign(timestamp)}`),
      makeProject({ webhook_signing_token: signingKey }),
    )

    expect(res.status).toBe(200)
  })

  test('rejects a signature over a different body', async () => {
    const timestamp = nowTimestamp()
    const res = await post(
      signedHeaders(timestamp, sign(timestamp, '{"tampered":true}')),
      makeProject({ webhook_signing_token: signingKey }),
    )

    expect(res.status).toBe(401)
  })

  test('rejects a stale timestamp', async () => {
    const stale = String(Math.floor(Date.now() / 1000) - 600)
    const res = await post(signedHeaders(stale), makeProject({ webhook_signing_token: signingKey }))

    expect(res.status).toBe(401)
  })

  test('does not fall back to the secret token when a signature is present but invalid', async () => {
    const res = await post(
      { ...signedHeaders(nowTimestamp(), 'v1,bogus'), 'X-Gitlab-Token': 'secret' },
      makeProject({ webhook_signing_token: signingKey }),
    )

    expect(res.status).toBe(401)
  })

  test('rejects a stripped signature even with a valid secret token', async () => {
    const res = await post(
      { 'X-Gitlab-Token': 'secret' },
      makeProject({ webhook_signing_token: signingKey }),
    )

    expect(res.status).toBe(401)
  })

  test('accepts a valid signature when no secret token is configured', async () => {
    const res = await post(
      signedHeaders(nowTimestamp()),
      makeProject({ webhook_secret: undefined, webhook_signing_token: signingKey }),
    )

    expect(res.status).toBe(200)
  })

  test('uses the secret token when no signing token is configured', async () => {
    const res = await post({ ...signedHeaders(nowTimestamp()), 'X-Gitlab-Token': 'secret' })

    expect(res.status).toBe(200)
  })

  test('rejects a wrong secret token', async () => {
    const res = await post({ 'X-Gitlab-Token': 'wrong' })

    expect(res.status).toBe(401)
  })
})

describe('verifyGitlabSignature', () => {
  const standardWebhooksVector = {
    signingKey: Buffer.from('MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw', 'base64'),
    messageId: 'msg_p5jXN8AQM9LWM0D4loKWxJek',
    timestamp: '1614265330',
    signatures: 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=',
    rawBody: '{"test": 2432232314}',
    nowSeconds: 1614265330,
  }

  test('accepts the Standard Webhooks reference signature', () => {
    expect(verifyGitlabSignature(standardWebhooksVector)).toBeNull()
  })

  test('rejects a timestamp too far in the future', () => {
    expect(verifyGitlabSignature({ ...standardWebhooksVector, nowSeconds: 1614265330 - 301 })).toBe(
      'invalid_timestamp',
    )
  })

  test('rejects a non-integer timestamp', () => {
    expect(verifyGitlabSignature({ ...standardWebhooksVector, timestamp: '1614265330.5' })).toBe(
      'invalid_timestamp',
    )
  })

  test.each(['messageId', 'timestamp', 'signatures'] as const)(
    'rejects a request missing %s',
    (field) => {
      expect(verifyGitlabSignature({ ...standardWebhooksVector, [field]: undefined })).toBe(
        'missing_signature_headers',
      )
    },
  )

  test('rejects a tampered body', () => {
    expect(
      verifyGitlabSignature({ ...standardWebhooksVector, rawBody: '{"test": 2432232315}' }),
    ).toBe('signature_mismatch')
  })
})

describe('gitlab webhook route logging', () => {
  let logSpy: ReturnType<typeof spyOn<Console, 'log'>>

  beforeEach(() => {
    logSpy = spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    logSpy.mockRestore()
  })

  const post = (
    body: string,
    headers: Record<string, string> = { 'X-Gitlab-Token': 'secret' },
    projectKey = 'test-project',
    project = makeProject(),
  ) => {
    return createGitlabWebhookRoute(
      { projects: new Map([[project.key, project]]), env: {} } as unknown as AppConfig,
      {} as Mastra,
    ).request(`/${projectKey}`, {
      method: 'POST',
      headers: { 'X-Gitlab-Event': 'Merge Request Hook', ...headers },
      body,
    })
  }

  const loggedLines = () => logSpy.mock.calls.map((call) => String(call[0]))

  test('escapes payload values in an ignored reason', async () => {
    const res = await post(JSON.stringify(makeMrPayload({ action: 'update\n[webhook] forged' })))

    expect(res.status).toBe(200)
    expect(loggedLines()).toEqual([
      '[webhook] test-project "Merge Request Hook" 200 ignored MR !42: action "update\\n[webhook] forged"',
    ])
  })

  test('logs a request that fails while being handled', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {})
    const project = makeProject({ trigger: undefined as unknown as GitLabProjectConfig['trigger'] })

    const res = await post(JSON.stringify(makeMrPayload()), undefined, 'test-project', project)

    expect(res.status).toBe(500)
    expect(loggedLines()).toEqual([
      '[webhook] test-project "Merge Request Hook" 500 internal error',
    ])
    expect(errorSpy).toHaveBeenCalledTimes(1)
    errorSpy.mockRestore()
  })

  test('logs an unknown project', async () => {
    const res = await post('{}', undefined, 'missing')

    expect(res.status).toBe(404)
    expect(loggedLines()).toEqual(['[webhook] "missing" "Merge Request Hook" 404 unknown project'])
  })

  test('logs an unauthorized request without the token', async () => {
    const res = await post(JSON.stringify(makeMrPayload()), { 'X-Gitlab-Token': 'wrong-token' })

    expect(res.status).toBe(401)
    expect(loggedLines()).toEqual([
      '[webhook] test-project "Merge Request Hook" 401 unauthorized (token_mismatch)',
    ])
    expect(loggedLines().join('\n')).not.toContain('wrong-token')
  })

  test('logs a body that is not JSON', async () => {
    const res = await post('not json')

    expect(res.status).toBe(400)
    expect(loggedLines()).toEqual([
      '[webhook] test-project "Merge Request Hook" 400 invalid payload',
    ])
  })

  test('logs an unsupported payload without its body', async () => {
    const res = await post(JSON.stringify({ object_kind: 'push', ref: 'refs/heads/private' }))

    expect(res.status).toBe(400)
    expect(loggedLines()).toEqual([
      '[webhook] test-project "Merge Request Hook" 400 invalid payload',
    ])
  })

  test('logs an ignored merge request with its IID and reason', async () => {
    const res = await post(JSON.stringify(makeMrPayload({ action: 'update', draft: true })))

    expect(res.status).toBe(200)
    expect(loggedLines()).toEqual([
      '[webhook] test-project "Merge Request Hook" 200 ignored MR !42: action "update", draft=true',
    ])
  })

  test('logs an ignored note without an MR IID', async () => {
    const res = await post(
      JSON.stringify(makeNotePayload({ noteableType: 'Issue', hasMr: false })),
      { 'X-Gitlab-Token': 'secret', 'X-Gitlab-Event': 'Note Hook' },
    )

    expect(res.status).toBe(200)
    expect(loggedLines()).toEqual([
      '[webhook] test-project "Note Hook" 200 ignored: note not on a merge request',
    ])
  })
})
