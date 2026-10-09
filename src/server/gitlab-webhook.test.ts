import { createHmac } from 'node:crypto'
import { describe, expect, test } from 'bun:test'
import type { Mastra } from '@mastra/core'
import type { AppConfig, GitLabProjectConfig } from '@/config'
import {
  classifyWebhook,
  createGitlabWebhookRoute,
  extractMrLabels,
  type MrWebhookPayload,
  type WebhookPayload,
} from '@/server/gitlab-webhook'

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
      model: 'test-model',
      thinking_level: 'minimal',
      timeout_ms: 45000,
      failure_policy: 'mixed',
    },
    comparison: { enabled: false, harness: 'opencode', timeout_ms: 300_000 },
    memory: { project_scope_usernames: [] },
    triage: { trusted_usernames: [] },
    fix: { enabled: false, automatic: false, max_loops: 3 },
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
  },
  labels: overrides.labels,
  changes: overrides.changes,
})

const makeNotePayload = (
  overrides: { noteableType?: string; hasMr?: boolean; noteId?: number } = {},
): WebhookPayload => ({
  object_kind: 'note' as const,
  project: { id: 1, name: 'test', web_url: 'https://gitlab.example.com/test' },
  user: { id: 2, username: 'reviewer' },
  object_attributes: {
    id: overrides.noteId ?? 99,
    note: 'Some comment',
    noteable_type: overrides.noteableType ?? 'MergeRequest',
    type: null,
    action: 'create',
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

  describe('note events', () => {
    test('note event on MR -> mr_note_received', () => {
      const project = makeProject()
      const payload = makeNotePayload({ noteableType: 'MergeRequest', hasMr: true })

      const result = classifyWebhook(project, payload)

      expect(result.type).toBe('mr_note_received')
      if (result.type === 'mr_note_received') {
        expect(result.mrIid).toBe(42)
        expect(result.noteId).toBe(99)
      }
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
  const signingToken = `whsec_${signingKey.toString('base64')}`
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
      makeProject({ webhook_signing_token: signingToken }),
    )

    expect(res.status).toBe(200)
    expect(((await res.json()) as { type: string }).type).toBe('ignored')
  })

  test('accepts a valid signature among multiple space-separated signatures', async () => {
    const timestamp = nowTimestamp()
    const res = await post(
      signedHeaders(timestamp, `v1,bogus ${sign(timestamp)}`),
      makeProject({ webhook_signing_token: signingToken }),
    )

    expect(res.status).toBe(200)
  })

  test('rejects a signature over a different body', async () => {
    const timestamp = nowTimestamp()
    const res = await post(
      signedHeaders(timestamp, sign(timestamp, '{"tampered":true}')),
      makeProject({ webhook_signing_token: signingToken }),
    )

    expect(res.status).toBe(401)
  })

  test('rejects a stale timestamp', async () => {
    const stale = String(Math.floor(Date.now() / 1000) - 600)
    const res = await post(
      signedHeaders(stale),
      makeProject({ webhook_signing_token: signingToken }),
    )

    expect(res.status).toBe(401)
  })

  test('does not fall back to the secret token when a signature is present but invalid', async () => {
    const res = await post(
      { ...signedHeaders(nowTimestamp(), 'v1,bogus'), 'X-Gitlab-Token': 'secret' },
      makeProject({ webhook_signing_token: signingToken }),
    )

    expect(res.status).toBe(401)
  })

  test('falls back to the secret token when no signature header is sent', async () => {
    const res = await post(
      { 'X-Gitlab-Token': 'secret' },
      makeProject({ webhook_signing_token: signingToken }),
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
