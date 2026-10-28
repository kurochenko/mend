import { afterEach, describe, expect, mock, test } from 'bun:test'
import type { GitLabProjectConfig } from '@/config'
import { fetchMr } from '@/integrations/gitlab/mr'

const project = {
  key: 'repo',
  platform: 'gitlab',
  url: 'https://gitlab.com',
  token: 'token',
  webhook_secret: 'secret',
  project_id: 'org/repo',
  repo_url: 'git@gitlab.com:org/repo.git',
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
} satisfies GitLabProjectConfig

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

const response = (sourceProjectId: number, targetProjectId: number) => ({
  title: 'MR',
  description: null,
  labels: [],
  source_branch: 'feature',
  source_project_id: sourceProjectId,
  target_project_id: targetProjectId,
  target_branch: 'main',
  web_url: 'https://gitlab.com/org/repo/-/merge_requests/1',
  sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  diff_refs: {
    base_sha: 'base',
    head_sha: 'head',
    start_sha: 'start',
  },
})

describe('fetchMr', () => {
  test('maps same-project merge requests to the configured repository', async () => {
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify(response(10, 10))),
    ) as unknown as typeof fetch

    await expect(fetchMr(project, 1)).resolves.toMatchObject({
      sourceRepository: 'org/repo',
    })
  })

  test('marks fork merge requests as cross-repository', async () => {
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify(response(20, 10))),
    ) as unknown as typeof fetch

    await expect(fetchMr(project, 1)).resolves.toMatchObject({
      sourceRepository: null,
    })
  })
})
