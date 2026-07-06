import { afterEach, describe, expect, mock, test } from 'bun:test'
import type { GitHubProjectConfig } from '@/config'
import { githubApi, githubPaginated } from '@/integrations/github/transport'
import { ProviderApiError } from '@/integrations/provider/error'

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
const originalSleep = Bun.sleep

afterEach(() => {
  globalThis.fetch = originalFetch
  Bun.sleep = originalSleep
})

describe('githubApi', () => {
  test('retries 429 with Retry-After', async () => {
    Bun.sleep = mock(async () => {})
    const fetchMock = mock()
      .mockImplementationOnce(
        async () => new Response('rate', { status: 429, headers: { 'Retry-After': '1' } }),
      )
      .mockImplementationOnce(async () => new Response('{"ok":true}', { status: 200 }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const res = await githubApi(project, '/user')

    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(Bun.sleep).toHaveBeenCalledWith(1000)
  })

  test('retries github secondary rate limit', async () => {
    Bun.sleep = mock(async () => {})
    const fetchMock = mock()
      .mockImplementationOnce(
        async () =>
          new Response('secondary', { status: 403, headers: { 'x-ratelimit-remaining': '0' } }),
      )
      .mockImplementationOnce(async () => new Response('{"ok":true}', { status: 200 }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await githubApi(project, '/user')

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  test('does not retry 422 and throws ProviderApiError fields', async () => {
    const fetchMock = mock(async () => new Response('bad', { status: 422 }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await expect(githubApi(project, '/user')).rejects.toMatchObject({
      name: 'ProviderApiError',
      status: 422,
      method: 'GET',
      message: 'GitHub API 422 GET /user: bad',
    } satisfies Partial<ProviderApiError>)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('githubPaginated', () => {
  test('follows Link rel next', async () => {
    const fetchMock = mock()
      .mockImplementationOnce(
        async () =>
          new Response('[{"id":1}]', {
            status: 200,
            headers: {
              Link: '<https://api.github.com/repos/org/repo/issues/1/comments?page=2>; rel="next"',
            },
          }),
      )
      .mockImplementationOnce(async () => new Response('[{"id":2}]', { status: 200 }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const result = await githubPaginated(
      project,
      '/repos/org/repo/issues/1/comments',
      (value) => value as Array<{ id: number }>,
    )

    expect(result).toEqual([{ id: 1 }, { id: 2 }])
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      'https://api.github.com/repos/org/repo/issues/1/comments?page=2',
    )
  })
})
