import { afterEach, describe, expect, mock, test } from 'bun:test'
import type { GitHubProjectConfig } from '@/config'
import { githubGraphql } from '@/integrations/github/graphql'
import type { ProviderApiError } from '@/integrations/provider/error'

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

describe('githubGraphql', () => {
  test('returns data', async () => {
    globalThis.fetch = mock(
      async () => new Response('{"data":{"ok":true}}'),
    ) as unknown as typeof fetch

    const result = await githubGraphql<{ ok: boolean }>(project, 'query Test { ok }', {})

    expect(result).toEqual({ ok: true })
  })

  test('surfaces graphql errors', async () => {
    globalThis.fetch = mock(
      async () => new Response('{"errors":[{"message":"first"},{"message":"second"}]}'),
    ) as unknown as typeof fetch

    await expect(githubGraphql(project, 'query Test { ok }', {})).rejects.toThrow('first; second')
  })

  test('uses typed transport errors for non-success responses', async () => {
    globalThis.fetch = mock(
      async () => new Response('bad query', { status: 422 }),
    ) as unknown as typeof fetch

    await expect(githubGraphql(project, 'query Test { ok }', {})).rejects.toMatchObject({
      name: 'ProviderApiError',
      status: 422,
      method: 'POST',
      message: 'GitHub API 422 POST GraphQL: bad query',
    } satisfies Partial<ProviderApiError>)
  })
})
